<template>
    <!-- 无边框窗口没有系统边框，这里提供 8 个透明的缩放热区，
         按下后交给 startResizeDragging 走系统缩放流程。
         tao 对「无边框 + shadow」窗口只在 WM_NCHITTEST 里处理上边缘，
         左右/下边缘靠这层热区补齐。 -->
    <div class="window-resize-handles" aria-hidden="true">
        <div
            v-for="handle in handles"
            :key="handle.direction"
            :class="['wrh', `wrh-${handle.suffix}`]"
            @mousedown.left.prevent="handleResize(handle.direction)"
        ></div>
    </div>
</template>

<script setup lang="ts">
// @tauri-apps/api/window 未导出 ResizeDirection 类型，这里按 startResizeDragging 的入参定义
type ResizeDirection =
    | 'East'
    | 'North'
    | 'NorthEast'
    | 'NorthWest'
    | 'South'
    | 'SouthEast'
    | 'SouthWest'
    | 'West';

const handles: Array<{ direction: ResizeDirection; suffix: string }> = [
    { direction: 'North', suffix: 'n' },
    { direction: 'South', suffix: 's' },
    { direction: 'West', suffix: 'w' },
    { direction: 'East', suffix: 'e' },
    { direction: 'NorthWest', suffix: 'nw' },
    { direction: 'NorthEast', suffix: 'ne' },
    { direction: 'SouthWest', suffix: 'sw' },
    { direction: 'SouthEast', suffix: 'se' },
];

async function handleResize(direction: ResizeDirection) {
    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().startResizeDragging(direction);
    } catch (e) {
        console.error('窗口缩放失败:', e);
    }
}
</script>

<style scoped>
.window-resize-handles {
    position: fixed;
    inset: 0;
    pointer-events: none;
    /* 低于 WindowControls(1000)，右上角的关闭/最大化按钮优先命中 */
    z-index: 900;
}

.wrh {
    position: absolute;
    pointer-events: auto;
    /* 留白处不遮挡内容交互，仅边缘 4px 生效 */
}

.wrh-n,
.wrh-s {
    left: 8px;
    right: 8px;
    height: 4px;
    cursor: ns-resize;
}

.wrh-n {
    top: 0;
}

.wrh-s {
    bottom: 0;
}

.wrh-w,
.wrh-e {
    top: 8px;
    bottom: 8px;
    width: 4px;
    cursor: ew-resize;
}

.wrh-w {
    left: 0;
}

.wrh-e {
    right: 0;
}

.wrh-nw,
.wrh-ne,
.wrh-sw,
.wrh-se {
    width: 8px;
    height: 8px;
}

.wrh-nw {
    top: 0;
    left: 0;
    cursor: nwse-resize;
}

.wrh-ne {
    top: 0;
    right: 0;
    cursor: nesw-resize;
}

.wrh-sw {
    bottom: 0;
    left: 0;
    cursor: nesw-resize;
}

.wrh-se {
    bottom: 0;
    right: 0;
    cursor: nwse-resize;
}
</style>
