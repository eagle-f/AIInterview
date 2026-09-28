<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";

const props = defineProps<{
  currentTime: number;
  totalDuration: number;
  started: boolean;
}>();

const emit = defineEmits(["updateTime"]);

const timePoints = ref<number[]>([]);
const startTime = ref<number>(0);
const intervalId = ref<number | null>(null);

// 生成时间点数组，从0到总时长，每5分钟一个刻度
for (let i = 0; i <= props.totalDuration; i += 5) {
  timePoints.value.push(i);
}
if (timePoints.value.at(-1) !== props.totalDuration) timePoints.value.push(props.totalDuration);

const stopTimer = () => {
  if (intervalId.value !== null) window.clearInterval(intervalId.value);
  intervalId.value = null;
};

// 监听started状态变化
watch(
  () => props.started,
  (newValue) => {
    if (!newValue) { stopTimer(); return; }
    if (newValue && !intervalId.value) {
      // 记录开始时间
      startTime.value = Date.now() - props.currentTime * 60000;
      // 启动定时器，每秒更新一次时间
      intervalId.value = window.setInterval(() => {
        const elapsedMinutes = (Date.now() - startTime.value) / 60000;
        // 确保不超过总时长
        const newTime = Math.min(elapsedMinutes, props.totalDuration);
        if (newTime !== props.currentTime) {
          emit("updateTime", newTime);
        }
        if (newTime >= props.totalDuration) stopTimer();
      }, 1000);
    }
  },
  { immediate: true },
);

// 组件卸载时清除定时器
onBeforeUnmount(stopTimer);
</script>

<template>
  <div class="timeline-container">
    <div class="timeline">
      <div
        v-for="time in timePoints"
        :key="time"
        class="time-point"
        :class="{ active: time === props.currentTime }"
        :style="{ top: `${(time / props.totalDuration) * 100}%` }"
      >
        <div class="time-marker"></div>
        <div class="time-label">{{ time }}分钟</div>
      </div>
      <div
        class="current-time-indicator"
        :class="{ active: intervalId != null }"
        :style="{ top: `${(props.currentTime / props.totalDuration) * 100}%` }"
      ></div>
    </div>
  </div>
</template>

<style scoped>
.timeline-container {
  width: 160px;
  height: 100%;
  padding: 20px 0;
  display: flex;
  justify-content: center;
  box-sizing: border-box;
}

.timeline {
  position: relative;
  height: 100%;
  width: 2px;
  background-color: #ddd;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.time-point {
  position: absolute;
  cursor: pointer;
  display: flex;
  align-items: center;
}

.time-marker {
  width: 10px;
  height: 2px;
  background-color: #ddd;
  position: absolute;
  left: 0;
}

.time-label {
  position: absolute;
  left: 15px;
  font-size: 12px;
  color: #666;
  white-space: nowrap;
}

.time-point.active .time-marker {
  background-color: #646cff;
}

.time-point.active .time-label {
  color: #646cff;
  font-weight: bold;
}

.current-time-indicator {
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background-color: brown;
  left: -5px;
  transform: translateY(-50%);
  box-shadow: 0 0 0 3px rgba(100, 108, 255, 0.2);
}

.current-time-indicator.active {
  background-color: #646cff;
}
</style>
