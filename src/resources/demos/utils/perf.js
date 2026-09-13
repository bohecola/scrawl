/**
 * 节流（throttle）
 *
 * 每隔 delay 最多执行一次 fn：第一次调用立刻放行，等待期内后续调用被忽略。
 */
function throttle(fn, delay = 1000) {
  let timer = null;
  return function () {
    if (timer) return;
    timer = setTimeout(() => {
      fn.apply(this, arguments);
      timer = null;
    }, delay);
  };
}

/**
 * 防抖（debounce）
 *
 * 连续触发时只保留最后一次：每次调用都重置计时，停止触发 delay 后才执行 fn。
 */
function debounce(fn, delay = 1000) {
  let timer = null;
  return function () {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn.apply(this, arguments);
      timer = null;
    }, delay);
  };
}

// TODO: 柯里化（示例未实现）
