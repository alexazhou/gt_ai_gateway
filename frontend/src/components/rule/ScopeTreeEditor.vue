<template>
    <div class="scope-node" :class="{ 'is-group': isGroup, 'is-const': isConst }">
        <!-- 组合节点（and / or） -->
        <div v-if="isGroup" class="group-node">
            <div class="group-row">
                <a-select
                    :value="(node as LogicNode).type"
                    size="small"
                    style="width: 170px"
                    :disabled="isRoot"
                    @change="changeGroupType"
                >
                    <a-select-option value="and">所有条件满足 (AND)</a-select-option>
                    <a-select-option value="or">任一条件满足 (OR)</a-select-option>
                </a-select>
                <a-button v-if="!isRoot" type="text" size="small" danger @click="emit('remove')">
                    <DeleteOutlined />
                </a-button>
            </div>
            <div class="group-children">
                <ScopeTreeEditor
                    v-for="(child, index) in (node as LogicNode).values"
                    :key="index"
                    :node="child"
                    :is-root="false"
                    @remove="removeChild(index)"
                />
            </div>
            <div class="group-actions">
                <a-button size="small" type="dashed" @click="addLeaf">
                    <PlusOutlined /> 条件
                </a-button>
                <a-button size="small" type="dashed" @click="addGroup('and')">
                    <PlusOutlined /> AND 组
                </a-button>
                <a-button size="small" type="dashed" @click="addGroup('or')">
                    <PlusOutlined /> OR 组
                </a-button>
                <a-button size="small" type="dashed" @click="addConst">
                    <PlusOutlined /> 全部匹配
                </a-button>
            </div>
        </div>

        <!-- 恒真节点（全部匹配） -->
        <div v-else-if="isConst" class="leaf-row const-row">
            <span class="const-tag">全部匹配</span>
            <span class="const-hint">（恒为真，所有请求命中）</span>
            <a-button v-if="!isRoot" type="text" size="small" danger @click="emit('remove')">
                <DeleteOutlined />
            </a-button>
        </div>

        <!-- 叶子节点 -->
        <div v-else class="leaf-row">
            <a-select v-model:value="(node as LeafNode).type" size="small" style="width: 110px">
                <a-select-option value="user_id">用户 ID</a-select-option>
                <a-select-option value="model_id">模型 ID</a-select-option>
                <a-select-option value="vendor_id">供应商 ID</a-select-option>
            </a-select>
            <a-select v-model:value="(node as LeafNode).oper" size="small" style="width: 110px">
                <a-select-option value="=">=</a-select-option>
                <a-select-option value="!=">!=</a-select-option>
                <a-select-option value="in">in</a-select-option>
                <a-select-option value="not in">not in</a-select-option>
            </a-select>
            <a-input
                :value="valuesText"
                size="small"
                :placeholder="valuesPlaceholder"
                style="width: 200px"
                @change="handleValuesChange"
            />
            <a-button v-if="!isRoot" type="text" size="small" danger @click="emit('remove')">
                <DeleteOutlined />
            </a-button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons-vue';
import type { ExprNode, LeafNode, LogicNode } from '@/types/rule';

const props = withDefaults(defineProps<{
    node: ExprNode;
    isRoot?: boolean;
}>(), {
    isRoot: false,
});

const emit = defineEmits<{
    remove: [];
}>();

const isGroup = computed(() => props.node.type === 'and' || props.node.type === 'or');
const isConst = computed(() => props.node.type === 'const');

const valuesPlaceholder = computed(() => {
    const oper = (props.node as LeafNode).oper;
    return oper === '=' || oper === '!=' ? '单个 ID' : '逗号分隔 ID 列表';
});

const valuesText = computed<string>({
    get: () => (props.node as LeafNode).values.join(', '),
    set: (text: string) => {
        (props.node as LeafNode).values = text
            .split(',')
            .map(part => parseInt(part.trim(), 10))
            .filter(num => !Number.isNaN(num));
    },
});

function handleValuesChange(e: Event): void {
    valuesText.value = (e.target as HTMLInputElement).value;
}

function changeGroupType(value: unknown): void {
    (props.node as LogicNode).type = value as 'and' | 'or';
}

function createLeaf(): LeafNode {
    return { type: 'model_id', oper: '=', values: [] };
}

function addLeaf(): void {
    (props.node as LogicNode).values.push(createLeaf());
}

function addGroup(type: 'and' | 'or'): void {
    const group: LogicNode = { type, values: [createLeaf()] };
    (props.node as LogicNode).values.push(group);
}

function addConst(): void {
    (props.node as LogicNode).values.push({ type: 'const', values: [true] });
}

function removeChild(index: number): void {
    (props.node as LogicNode).values.splice(index, 1);
}
</script>

<style scoped>
.scope-node {
    width: 100%;
}

.group-node {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 12px;
    background: var(--bg-elevated);
}

.group-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
}

.group-children {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-left: 12px;
    border-left: 2px dashed var(--border-color);
}

.group-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    flex-wrap: wrap;
}

.leaf-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.const-row {
    padding: 6px 10px;
    border: 1px dashed var(--border-color);
    border-radius: 8px;
    background: var(--bg-page);
}

.const-tag {
    color: var(--accent-primary);
    font-weight: 600;
}

.const-hint {
    color: var(--text-secondary);
    font-size: 12px;
}
</style>
