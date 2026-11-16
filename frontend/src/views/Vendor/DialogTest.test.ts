import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import DialogTest from './DialogTest.vue';

const { testVendor, listVendorModels, testModelRoute } = vi.hoisted(() => ({
    testVendor: vi.fn(),
    listVendorModels: vi.fn(),
    testModelRoute: vi.fn(),
}));

vi.mock('@/api/vendor', () => ({
    testVendor,
    listVendorModels,
}));

vi.mock('@/api/model', () => ({
    testModelRoute,
}));

vi.mock('@/utils/requestFeedback', () => ({
    notifyRequestError: vi.fn(() => ({ message: 'err' })),
    notifySuccess: vi.fn(),
    notifyWarning: vi.fn(),
}));

vi.mock('ant-design-vue', () => ({
    message: { success: vi.fn(), error: vi.fn() },
}));

// 下标访问在本项目的 tsconfig（noUncheckedIndexedAccess）下是 T | undefined，
// 这里显式解包：缺失时直接抛带名字的错误，而不是让 vue-tsc -b 报 TS2532。
function must<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw new Error(`期望存在：${what}`);
    return value;
}

// 轻量桩：只保留本用例关心的交互能力（v-model 双向 + 点击）
const ModalStub = defineComponent({ template: '<div><slot /></div>' });
const DivStub = defineComponent({ template: '<div><slot /></div>' });
const ButtonStub = defineComponent({
    props: ['disabled', 'loading'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
});
// 注意：ant-design-vue 的 a-radio-group 用的是 v-model:value（prop `value` + 事件 update:value），
// 不是 v-model 的 modelValue —— 桩写错的话 v-model 不会生效，用例会「看着在测其实没切」。
const RadioGroupStub = defineComponent({
    props: ['value'],
    emits: ['update:value'],
    template: '<div class="radio-group"><slot /></div>',
});
const RadioButtonStub = defineComponent({
    props: ['value'],
    template: '<label :data-value="value"><slot /></label>',
});
const TabsStub = defineComponent({
    props: ['activeKey'],
    template: '<div><slot /></div>',
});
const TabPaneStub = defineComponent({ template: '<div><slot /></div>' });
const SelectStub = defineComponent({
    props: ['modelValue'],
    emits: ['update:modelValue', 'search'],
    template: '<div class="select"><slot /></div>',
});
const SpaceStub = defineComponent({ template: '<div><slot /></div>' });

const global = {
    components: {
        AModal: ModalStub,
        AForm: DivStub,
        AFormItem: DivStub,
        AButton: ButtonStub,
        ARadioGroup: RadioGroupStub,
        ARadioButton: RadioButtonStub,
        ATabs: TabsStub,
        ATabPane: TabPaneStub,
        ASpace: SpaceStub,
        ADivider: DivStub,
        ABadge: DivStub,
        ASelect: SelectStub,
        CopyOutlined: DivStub,
    },
    stubs: {
        // 结果区这些组件与本次断言无关，直接桩掉
        ATag: true,
    },
};

const vendor = { id: 7, name: 'V', type: 'openai' } as any;


async function mountDialog() {
    const wrapper = mount(DialogTest, { global });
    return wrapper;
}


function primaryButton(wrapper: any) {
    // 模板里唯一的 type=primary 的按钮就是「开始测试」
    return wrapper.findAll('button').at(-1);
}


describe('DialogTest 请求类型（content_mode）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listVendorModels.mockResolvedValue([{ model_id: 'm-1' }]);
        testVendor.mockResolvedValue({ success: true, status: 200, content_mode: 'text', request_body: {} });
        testModelRoute.mockResolvedValue({ success: true, status: 200, content_mode: 'text', request_body: {} });
    });

    it('默认文本模式：点开始测试时 content_mode 传 text', async () => {
        const wrapper = await mountDialog();
        (wrapper.vm as any).openVendorTest(vendor, 'm-1');
        await nextTick();
        await new Promise((r) => setTimeout(r, 0));

        await primaryButton(wrapper)!.trigger('click');
        await new Promise((r) => setTimeout(r, 0));

        expect(testVendor).toHaveBeenCalledTimes(1);
        // (id, format, model, autoConvert, contentMode)
        expect(must(testVendor.mock.calls[0], '第一次 testVendor 调用')[4]).toBe('text');
    });

    it('切到多模态：清空上一次结果，并用 image 发起请求', async () => {
        const wrapper = await mountDialog();
        (wrapper.vm as any).openVendorTest(vendor, 'm-1');
        await nextTick();
        await new Promise((r) => setTimeout(r, 0));

        await primaryButton(wrapper)!.trigger('click');
        await new Promise((r) => setTimeout(r, 0));
        expect(wrapper.text()).toContain('连接成功');

        // 第二个 radio-group 是「请求类型」（第一个是协议）
        const groups = wrapper.findAllComponents(RadioGroupStub);
        expect(groups.length).toBeGreaterThanOrEqual(2);
        must(groups[1], '「请求类型」单选组').vm.$emit('update:value', 'image');
        await nextTick();

        // 切换后结果被清空（不然多模态结果会留在文本模式下面，看起来像文本请求的返回）
        expect(wrapper.text()).not.toContain('连接成功');

        await primaryButton(wrapper)!.trigger('click');
        await new Promise((r) => setTimeout(r, 0));
        expect(must(testVendor.mock.calls[1], '第二次 testVendor 调用')[4]).toBe('image');
    });

    it('模型可用性测试同样带 content_mode，且打开时重置为 text', async () => {
        const wrapper = await mountDialog();
        const vm = wrapper.vm as any;

        vm.openModelTest('gpt-4o');
        await nextTick();
        const groups = wrapper.findAllComponents(RadioGroupStub);
        must(groups[1], '「请求类型」单选组').vm.$emit('update:value', 'image');
        await nextTick();

        // 重新打开对话框 ⇒ 回到 text
        vm.openModelTest('gpt-4o');
        await nextTick();

        await primaryButton(wrapper)!.trigger('click');
        await new Promise((r) => setTimeout(r, 0));

        expect(testModelRoute).toHaveBeenCalledTimes(1);
        expect(must(testModelRoute.mock.calls[0], '第一次 testModelRoute 调用')[2]).toBe('text');
    });
});
