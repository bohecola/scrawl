/**
 * 用 setTimeout 实现 setInterval
 *
 * 思路：setInterval 是每隔固定时间重复执行；而 setTimeout 只跑一次。
 * 这里在每次回调里再排一个 setTimeout，实现「执行完再等 delay，如此循环」。
 */
function newInterval(func, delay) {
  function inside() {
    func();
    // 每次执行完都重新排下一次，形成循环
    setTimeout(inside, delay);
  }
  // 先排一次，让任务进入队列
  setTimeout(inside, delay);
}

function taskLog() {
  console.log('task is running.');
}
newInterval(taskLog, 1000);
