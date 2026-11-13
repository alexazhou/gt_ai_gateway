import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import VendorModels from './VendorModels.vue';

const { getVendor, listVendorModels, fetchVendorModels, syncVendorModels } = vi.hoisted(() => ({
    getVendor: vi.fn(),
    listVendorModels: vi.fn(),
    fetchVendorModels: vi.fn(),
    syncVendorModels: vi.fn(),
}));

vi.mock('@/api/vendor', () => ({
    getVendor,
    listVendorModels,
    fetchVendorModels,
    syncVendorModels,
    addVendorModel: vi.fn(),
    updateVendorModel: vi.fn(),
    deleteVendorModel: vi.fn(),
}));

vi.mock('@/utils/requestFeedback', () => ({
    notifyRequestError: vi.fn(),
    notifySuccess: vi.fn(),
}));

vi.mock('vue-router', () => ({
    useRoute: () => ({ params: { id: '1' } }),
    useRouter: () => ({ push: vi.fn() }),
}));

// 只保留真实交互的复选框；其余 antd 组件用空壳，弹窗强制渲染插槽内容
const CheckboxStub = defineComponent({
    props: { checked: Boolean, disabled: Boolean },
    emits: ['change', 'click'],
    template: `<label><input type="checkbox" :checked="checked" :disabled="disabled"
        @change="$emit('change', $event)" @click.stop="$emit('click', $event)" /><slot /></label>`,
});

const SlotStub = defineComponent({
    template: '<div><slot /></div>',
});

const ButtonStub = defineComponent({
    emits: ['click'],
    template: `<button @click="$emit('click')"><slot /></button>`,
});

function buildMountOptions() {
    return {
        global: {
            components: {
                ACheckbox: CheckboxStub,
                AButton: ButtonStub,
                AModal: SlotStub,
                ABreadcrumb: SlotStub,
                ABreadcrumbItem: SlotStub,
                ACard: SlotStub,
                AForm: SlotStub,
                AFormItem: SlotStub,
                ARadioGroup: SlotStub,
                ACheckboxGroup: SlotStub,
                ASpace: SlotStub,
            },
            stubs: {
                ATable: true,
                ATag: true,
                AInput: true,
                ARadio: true,
                DialogTest: true,
            },
        },
    };
}

async function mountAndFetch(savedModelIds: string[], upstreamModels: string[]) {
    getVendor.mockResolvedValue({ id: 1, name: 'opencode-go' });
    listVendorModels.mockResolvedValue(
        savedModelIds.map((modelId, index) => ({
            id: index + 1,
            vendor_id: 1,
            model_id: modelId,
            allowed_formats: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
        })),
    );
    fetchVendorModels.mockResolvedValue({ models: upstreamModels });

    const wrapper = mount(VendorModels, buildMountOptions());
    await flushPromises();

    const syncButton = wrapper.findAll('button').find(b => b.text().includes('自动获取'));
    await syncButton!.trigger('click');
    await flushPromises();

    return wrapper;
}

function flushPromises() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function itemFor(wrapper: ReturnType<typeof mount>, modelId: string) {
    return wrapper
        .findAll('.model-checkbox-item')
        .find(i => i.find('.model-checkbox-label').text() === modelId)!;
}

function checkboxFor(wrapper: ReturnType<typeof mount>, modelId: string) {
    return itemFor(wrapper, modelId).find('input[type="checkbox"]');
}

describe('VendorModels 自动获取弹窗', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('把已保存的模型预勾选、置为不可取消，并标记「已添加」', async () => {
        const wrapper = await mountAndFetch(['gpt-4o'], ['gpt-4o', 'claude-3-5-sonnet']);

        const saved = checkboxFor(wrapper, 'gpt-4o');
        expect(saved.attributes('checked')).toBeDefined();
        expect(saved.attributes('disabled')).toBeDefined();
        expect(itemFor(wrapper, 'gpt-4o').find('.model-saved-tag').text()).toBe('已添加');

        const fresh = checkboxFor(wrapper, 'claude-3-5-sonnet');
        expect(fresh.attributes('checked')).toBeUndefined();
        expect(fresh.attributes('disabled')).toBeUndefined();
        expect(itemFor(wrapper, 'claude-3-5-sonnet').find('.model-saved-tag').exists()).toBe(false);
    });

    it('点击已保存的模型无法取消勾选', async () => {
        const wrapper = await mountAndFetch(['gpt-4o'], ['gpt-4o', 'claude-3-5-sonnet']);

        await wrapper.findAll('.model-checkbox-item').find(i => i.text().includes('gpt-4o'))!.trigger('click');
        await flushPromises();

        expect(checkboxFor(wrapper, 'gpt-4o').attributes('checked')).toBeDefined();
    });

    it('"全不选" 不会取消已保存的模型', async () => {
        const wrapper = await mountAndFetch(['gpt-4o'], ['gpt-4o', 'claude-3-5-sonnet']);

        const noneButton = wrapper.findAll('button').find(b => b.text().includes('全不选'));
        await noneButton!.trigger('click');
        await flushPromises();

        expect(checkboxFor(wrapper, 'gpt-4o').attributes('checked')).toBeDefined();
        expect(checkboxFor(wrapper, 'claude-3-5-sonnet').attributes('checked')).toBeUndefined();
    });
});
