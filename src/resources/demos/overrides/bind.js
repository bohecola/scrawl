/**
 * 手写 Function.prototype.bind
 *
 * bind 返回一个新函数：调用时机合并「绑定时的参数 args」与「调用时的参数 subArgs」，
 * 一并传给原函数 fn。若被当作构造函数使用（new.target 存在），则忽略绑定的 this，
 * 直接用原函数构造新实例。
 */
Function.prototype.myBind = function (ctx, ...args) {
  const fn = this;

  return function (...subArgs) {
    const allArgs = [...args, ...subArgs];
    // 作为构造函数调用：this 指向新实例，忽略绑定的 ctx
    if (new.target) {
      return new fn(...allArgs);
    }
    // 普通调用：this 绑定到 ctx
    return fn.apply(ctx, allArgs);
  };
};

// 测试：绑定 ctx 为 'ctx'，预传 1、2，调用时再补 3、4
function fn(a, b, c, d) {
  console.log('fn called');
  console.log('args', a, b, c, d);
  console.log('this', this);
  return 123;
}

const newFn = fn.myBind('ctx', 1, 2);
console.log(newFn(3, 4));
