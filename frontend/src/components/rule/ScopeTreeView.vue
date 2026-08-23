<template>
    <div class="scope-tree-view">
        <!-- 分组节点：and / or -->
        <div v-if="isGroup" class="sv-group">
            <div class="sv-group-header">
                <a-tooltip
                    :title="node.type === 'and' ? '所有子条件均需满足' : '任一子条件满足即可'"
                    placement="top"
                >
                    <span class="sv-group-tag" :class="node.type === 'and' ? 'is-and' : 'is-or'">
                        {{ node.type === 'and' ? 'AND' : 'OR' }}
                    </span>
                </a-tooltip>
            </div>
            <div class="sv-children">
                <div
                    v-for="(child, index) in (node as LogicNode).values"
                    :key="index"
                    class="sv-child-wrapper"
                >
                    <ScopeTreeView
                        :scope="child"
                        :options="options"
                    />
                </div>
            </div>
        </div>

        <!-- 叶子条件 -->
        <div v-else-if="isLeaf" class="sv-leaf" :class="`dim-${(node as LeafNode).type}`">
            <span class="sv-dim">{{ DIMENSION_LABELS[(node as LeafNode).type] }}</span>
            <span class="sv-op">{{ OPERATOR_LABELS[(node as LeafNode).oper] }}</span>
            <span class="sv-values">{{ formattedValues }}</span>
        </div>

        <!-- 固定值：true / false -->
        <span v-else class="sv-const" :class="(node as ConstNode).values[0] ? 'is-true' : 'is-false'">
            {{ (node as ConstNode).values[0] ? '全部匹配' : '全部不匹配' }}
        </span>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ConstNode, ExprNode, LeafNode, LogicNode, ScopeOptions } from '@/types/rule';

const props = withDefaults(defineProps<{
    scope: ExprNode;
    options?: ScopeOptions;
}>(), {
    options: () => ({ models: [], users: [], vendors: [] }),
});

const node = computed(() => props.scope);

const DIMENSION_LABELS: Record<string, string> = {
    user_id: '用户',
    model_id: '模型',
    vendor_id: '供应商',
};

const OPERATOR_LABELS: Record<string, string> = {
    '=': '=',
    '!=': '≠',
    in: '∈',
    'not in': '∉',
};

const isGroup = computed(() => props.scope.type === 'and' || props.scope.type === 'or');
const isLeaf = computed(() => (
    props.scope.type === 'user_id'
    || props.scope.type === 'model_id'
    || props.scope.type === 'vendor_id'
));

const formattedValues = computed(() => {
    if (!isLeaf.value) return '';
    const leaf = props.scope as LeafNode;
    if (!leaf.values || leaf.values.length === 0) {
        return '（未配置）';
    }
    const optionList = props.options
        ? (leaf.type === 'model_id'
            ? props.options.models
            : leaf.type === 'user_id'
                ? props.options.users
                : props.options.vendors)
        : [];
    const nameMap = new Map<number, string>(optionList.map(opt => [opt.id, opt.name]));
    return leaf.values.map(val => nameMap.get(val) || String(val)).join(', ');
});
</script>

<style scoped>
.scope-tree-view {
    --tree-line-color: #8c9ba5;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-primary);
    width: fit-content;
}

.dark .scope-tree-view,
:deep(.dark) .scope-tree-view {
    --tree-line-color: #5c6b77;
}

/* 分组节点容器 */
.sv-group {
    display: flex;
    flex-direction: column;
}

.sv-group-header {
    display: inline-flex;
    align-items: center;
    position: relative;
    padding-bottom: 2px;
}

.sv-group-header::after {
    content: '';
    position: absolute;
    left: 12px;
    top: 20px;
    bottom: 0;
    width: 0;
    border-left: 1.5px solid var(--tree-line-color);
}

/* 分组 Tag (AND / OR) */
.sv-group-tag {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    height: 20px;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    line-height: 18px;
    letter-spacing: 0.5px;
    white-space: nowrap;
    user-select: none;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}

.sv-group-tag.is-and {
    color: var(--accent-primary, #1677ff);
    background: var(--accent-primary-soft, rgba(22, 119, 255, 0.1));
    border: 1px solid var(--accent-primary-border, rgba(22, 119, 255, 0.3));
}

.sv-group-tag.is-or {
    color: #d46b08;
    background: #fff7e6;
    border: 1px solid #ffd591;
}

.dark .sv-group-tag.is-or,
:deep(.dark) .sv-group-tag.is-or {
    color: #ffa940;
    background: rgba(250, 140, 22, 0.15);
    border: 1px solid rgba(250, 140, 22, 0.35);
}

/* 子节点区域：形成树状分支 */
.sv-children {
    position: relative;
    margin-left: 12px;
    padding-left: 14px;
    display: flex;
    flex-direction: column;
}

/* 单个子节点包装器：通过伪元素绘制命令行 tree 形式的连接线 */
.sv-child-wrapper {
    position: relative;
    padding: 2px 0;
    display: flex;
    align-items: flex-start;
}

/* 垂直主干线：贯穿子节点项 */
.sv-child-wrapper::before {
    content: '';
    position: absolute;
    left: -14px;
    top: 0;
    bottom: 0;
    width: 0;
    border-left: 1.5px solid var(--tree-line-color);
}

/* 水平分支线：从主干线延伸至子节点项 */
.sv-child-wrapper::after {
    content: '';
    position: absolute;
    left: -14px;
    top: 13px;
    width: 14px;
    height: 0;
    border-top: 1.5px solid var(--tree-line-color);
}

/* 最后一个子节点：垂直线止于水平分支线，形成 └── 拐角 */
.sv-child-wrapper:last-child::before {
    bottom: auto;
    height: 13px;
}

/* 叶子条件卡片/徽标 */
.sv-leaf {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--bg-info-item, #f8fafc);
    border: 1px solid var(--border-info-item, #e8edf5);
    white-space: nowrap;
    line-height: 20px;
    min-height: 22px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
}

/* 维度标签 */
.sv-dim {
    font-weight: 600;
    font-size: 11px;
    padding: 0 4px;
    border-radius: 3px;
    line-height: 16px;
}

.sv-leaf.dim-model_id .sv-dim {
    color: var(--accent-primary, #1677ff);
    background: var(--accent-primary-soft, rgba(22, 119, 255, 0.1));
}

.sv-leaf.dim-user_id .sv-dim {
    color: #389e0d;
    background: rgba(82, 196, 26, 0.1);
}

.sv-leaf.dim-vendor_id .sv-dim {
    color: #722ed1;
    background: rgba(114, 46, 209, 0.1);
}

/* 运算符 */
.sv-op {
    color: var(--text-secondary, #8c8c8c);
    font-weight: 600;
    font-size: 12px;
    padding: 0 1px;
}

/* 比较值 */
.sv-values {
    font-family: var(--font-mono, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace);
    font-size: 12px;
    font-weight: 500;
    color: var(--text-primary);
}

/* 固定值节点 */
.sv-const {
    display: inline-flex;
    align-items: center;
    padding: 0 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    line-height: 20px;
    white-space: nowrap;
}

.sv-const.is-true {
    color: #389e0d;
    background: rgba(82, 196, 26, 0.1);
    border: 1px solid rgba(82, 196, 26, 0.3);
}

.sv-const.is-false {
    color: #cf1322;
    background: rgba(255, 77, 79, 0.1);
    border: 1px solid rgba(255, 77, 79, 0.3);
}
</style>
