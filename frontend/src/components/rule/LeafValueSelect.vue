<template>
    <!-- 有维度选项时下拉选择（单选 / 多选随运算符切换）；无选项时退回文本输入（可手填 ID） -->
    <template v-if="hasDimensionOptions">
        <a-select
            v-if="isSingleOper"
            v-model:value="singleValue"
            size="small"
            show-search
            :options="currentOptions"
            :placeholder="valuesPlaceholder"
            class="leaf-values-select"
        />
        <a-select
            v-else
            v-model:value="multiValues"
            mode="multiple"
            size="small"
            show-search
            :options="currentOptions"
            :placeholder="valuesPlaceholder"
            class="leaf-values-select"
        />
    </template>
    <a-input
        v-else
        :value="valuesText"
        size="small"
        :placeholder="valuesPlaceholder"
        class="leaf-values-input"
        @change="handleValuesChange"
    />
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import type { ScopeField, ScopeOperator, ScopeOptions } from '@/types/rule';

const props = withDefaults(defineProps<{
    /** 叶子维度：model_id / user_id / vendor_id，决定下拉哪个列表 */
    valueType: ScopeField;
    /** 运算符：= / != 单选，in / not in 多选 */
    oper: ScopeOperator;
    /** 三个维度的下拉选项集 */
    options?: ScopeOptions;
    /** 当前已选值（v-model） */
    values: number[];
}>(), {
    options: () => ({ models: [], users: [], vendors: [] }),
});

const emit = defineEmits<{
    'update:values': [values: number[]];
}>();

const isSingleOper = computed(() => props.oper === '=' || props.oper === '!=');

const dimensionLabel = computed(() => {
    if (props.valueType === 'model_id') return '模型';
    if (props.valueType === 'user_id') return '用户';
    return '供应商';
});

// 当前维度对应的下拉选项（id = 条件比较值）
const dimensionOptions = computed<{ value: number; label: string }[]>(() => {
    const list = props.valueType === 'model_id'
        ? props.options.models
        : props.valueType === 'user_id'
            ? props.options.users
            : props.options.vendors;
    return list.map(item => ({ value: item.id, label: item.name }));
});

const hasDimensionOptions = computed(() => dimensionOptions.value.length > 0);

// 下拉选项：维度列表 + 当前已选但不在列表内的值兜底（如模型已被删除，编辑时仍能显示）
const currentOptions = computed(() => {
    const options = dimensionOptions.value.map(item => ({ ...item }));
    const existingIds = new Set(options.map(item => item.value));
    for (const id of props.values) {
        if (!existingIds.has(id)) {
            options.push({ value: id, label: `ID ${id}` });
        }
    }
    return options;
});

// 单选（= / !=）：values 为单元素
const singleValue = computed<number | undefined>({
    get: () => props.values[0],
    set: (val) => {
        emit('update:values', val === undefined || val === null ? [] : [val]);
    },
});

// 多选（in / not in）：values 为列表
const multiValues = computed<number[]>({
    get: () => props.values,
    set: (val) => emit('update:values', val),
});

const valuesPlaceholder = computed(() => {
    if (isSingleOper.value) return `选择${dimensionLabel.value}`;
    return `选择${dimensionLabel.value}（可多选）`;
});

// 文本输入兜底（无选项时手填 ID）
const valuesText = computed<string>({
    get: () => props.values.join(', '),
    set: (text) => {
        emit('update:values', text
            .split(',')
            .map(part => parseInt(part.trim(), 10))
            .filter(num => !Number.isNaN(num)));
    },
});

function handleValuesChange(e: Event): void {
    valuesText.value = (e.target as HTMLInputElement).value;
}

// 运算符在单选/多选间切换时，归一化 values 结构（多→单选截取首个值）
watch(() => props.oper, (oper) => {
    if ((oper === '=' || oper === '!=') && props.values.length > 1) {
        emit('update:values', props.values.slice(0, 1));
    }
});
</script>

<style scoped>
/* flex: 1 填满父行剩余空间，保证与维度/运算符在同一行 */
.leaf-values-input {
    flex: 1;
    min-width: 120px;
}

.leaf-values-select {
    flex: 1;
    min-width: 160px;
}
</style>
