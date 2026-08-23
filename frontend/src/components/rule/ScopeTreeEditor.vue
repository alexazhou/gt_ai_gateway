<template>
    <div class="tree-node">
        <div class="node-row">
            <a-select
                :value="nodeKind"
                size="small"
                class="node-type-select"
                @change="changeNodeKind"
            >
                <a-select-option value="and">AND</a-select-option>
                <a-select-option value="or">OR</a-select-option>
                <a-select-option value="leaf">条件</a-select-option>
                <a-select-option value="const">固定值</a-select-option>
            </a-select>

            <!-- 叶子条件内容 -->
            <template v-if="isLeaf">
                <a-select v-model:value="(node as LeafNode).type" size="small" class="leaf-field-select">
                    <a-select-option value="user_id">用户 ID</a-select-option>
                    <a-select-option value="model_id">模型 ID</a-select-option>
                    <a-select-option value="vendor_id">供应商 ID</a-select-option>
                </a-select>
                <a-select v-model:value="(node as LeafNode).oper" size="small" class="leaf-field-select">
                    <a-select-option value="=">=</a-select-option>
                    <a-select-option value="!=">≠</a-select-option>
                    <a-select-option value="in">in</a-select-option>
                    <a-select-option value="not in">not in</a-select-option>
                </a-select>
                <a-input
                    :value="valuesText"
                    size="small"
                    :placeholder="valuesPlaceholder"
                    class="leaf-values-input"
                    @change="handleValuesChange"
                />
            </template>

            <!-- 分组提示 -->
            <span v-else-if="isGroup" class="group-hint">
                {{ node.type === 'and' ? '子条件全部满足' : '子条件任一满足' }}
            </span>

            <!-- 固定值（const）：true / false 可选 -->
            <template v-else-if="isConst">
                <span class="const-label">固定值</span>
                <a-select v-model:value="(node as ConstNode).values[0]" size="small" class="const-select">
                    <a-select-option :value="true">true</a-select-option>
                    <a-select-option :value="false">false</a-select-option>
                </a-select>
                <span class="const-hint">
                    {{ (node as ConstNode).values[0] ? '恒为真，所有请求命中' : '恒为假，所有请求不命中' }}
                </span>
            </template>

            <a-button v-if="!isRoot" type="text" size="small" danger @click="emit('remove')">
                <DeleteOutlined />
            </a-button>
        </div>

        <!-- and/or 子节点树：+ 添加条件 挂在父节点（本分组）下 -->
        <div v-if="isGroup" class="tree-children">
            <div v-for="(child, index) in (node as LogicNode).values" :key="index" class="tree-child-row">
                <ScopeTreeEditor :node="child" @remove="removeChild(index)" />
            </div>
            <div class="tree-add-row">
                <a-button size="small" type="dashed" class="add-button" @click="addChild">
                    <PlusOutlined /> 添加条件
                </a-button>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons-vue';
import type { ConstNode, ExprNode, LeafNode, LogicNode } from '@/types/rule';

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
const isLeaf = computed(() => (
    props.node.type === 'user_id'
    || props.node.type === 'model_id'
    || props.node.type === 'vendor_id'
));
const isConst = computed(() => props.node.type === 'const');

// 编辑器内的节点类型：and / or / leaf（叶子条件）/ const（全部匹配）
const nodeKind = computed<'and' | 'or' | 'leaf' | 'const'>(() => {
    const type = props.node.type;
    if (type === 'and') return 'and';
    if (type === 'or') return 'or';
    if (type === 'const') return 'const';
    return 'leaf';
});

function createLeaf(): LeafNode {
    return { type: 'model_id', oper: '=', values: [] };
}

/** 切换节点类型：按目标类型重构节点结构（and ↔ or 保留子节点，其余重建） */
function changeNodeKind(kind: unknown): void {
    const node = props.node as Record<string, any>;
    const next = kind as 'and' | 'or' | 'leaf' | 'const';

    if (next === 'and' || next === 'or') {
        if (props.node.type === 'and' || props.node.type === 'or') {
            node.type = next;
            return;
        }
        node.type = next;
        delete node.oper;
        node.values = [createLeaf()];
        return;
    }
    if (next === 'leaf') {
        node.type = 'model_id';
        node.oper = '=';
        node.values = [];
        return;
    }
    // const
    node.type = 'const';
    delete node.oper;
    node.values = [true];
}

function addChild(): void {
    (props.node as LogicNode).values.push(createLeaf());
}

function removeChild(index: number): void {
    (props.node as LogicNode).values.splice(index, 1);
}

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
</script>

<style scoped>
.tree-node {
    width: 100%;
}

.node-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 6px 8px;
    border-radius: 6px;
}

/* 树形子节点：左竖线引导 + 缩进，形成分支视觉 */
.tree-children {
    margin-left: 18px;
    padding-left: 14px;
    border-left: 1px dashed var(--border-color);
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.tree-child-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
}

.tree-add-row {
    padding: 4px 0;
}

.node-type-select {
    width: 96px;
}

.leaf-field-select {
    width: 110px;
}

.leaf-values-input {
    width: 180px;
}

.group-hint {
    color: var(--text-secondary);
    font-size: 12px;
}

.const-label {
    color: var(--text-secondary);
    font-size: 12px;
}

.const-select {
    width: 70px;
}

.const-hint {
    color: var(--accent-primary);
    font-size: 12px;
    font-weight: 600;
}

.add-button {
    color: var(--accent-primary);
}
</style>
