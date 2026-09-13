/**
 * 手写 Function.prototype.call
 *
 * 核心思路：把调用函数临时挂到目标对象上，利用「方法调用时 this 指向接收者」的规则，
 * 将 this 绑定到 ctx；调用结束后再删除临时属性。
 */
Function.prototype.myCall = function (ctx, ...args) {
  // 1. 确定 this 指向：null/undefined 落到全局对象，其余统一转对象（兼容基本类型）
  ctx = ctx === null || ctx === undefined ? globalThis : Object(ctx);

  // 2. 用 Symbol 生成不冲突的临时 key，避免覆盖对象已有属性
  const key = Symbol("temp");
  Object.defineProperty(ctx, key, {
    configurable: true,
    enumerable: false,
    value: this,
  });

  // 3. 调用并收集返回值，最后删除临时属性
  const result = ctx[key](...args);
  delete ctx[key];
  return result;
};

// 测试：this 应指向传入对象，参数 a、b 正常传递
function method(a, b) {
  console.log(this, a, b);
  return a + b;
}
method.myCall({}, 2, 3);
