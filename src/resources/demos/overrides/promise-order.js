/**
 * Promise + 定时器 的执行顺序
 *
 * 队列优先级：同步代码 > 微任务（.then） > 宏任务（setTimeout）。
 * 这段示例用来观察输出次序，预期结果：1、start、end、2。
 */
const p1 = new Promise((resolve) => {
  // 1) 同步执行
  console.log(1);

  // 2) 注册宏任务，本轮结束后的下一轮才执行
  setTimeout(() => {
    console.log('start');
    resolve(2);
    console.log('end');
  });
});

// 3) resolve 后回调进入微任务队列，会在宏任务之后、下一轮之前执行
p1.then((res) => {
  console.log(res);
});
