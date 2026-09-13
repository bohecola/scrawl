/**
 * 手写 Function.prototype.apply
 *
 * 与 call 的唯一区别：第二个参数是数组（或类数组），调用时会被展开成参数列表。
 * 核心思路同 call：把调用函数临时挂到目标对象上，借助「方法调用时 this 指向接收者」
 * 的规则将 this 绑定到 ctx，调用结束后再删除临时属性。
 */
Function.prototype.myApply = function (ctx, argsArr) {
  // 1. 确定 this 指向：null/undefined 落到全局对象，其余统一转对象（兼容基本类型）
  ctx = ctx === null || ctx === undefined ? globalThis : Object(ctx);

  // 2. 用 Symbol 生成不冲突的临时 key，避免覆盖对象已有属性
  const key = Symbol("temp");
  Object.defineProperty(ctx, key, {
    configurable: true,
    enumerable: false,
    value: this,
  });

  // 3. 非数组时直接调用（仅绑定 this），否则展开数组参数
  if (!Array.isArray(argsArr)) return ctx[key]();
  const res = ctx[key](...argsArr);
  delete ctx[key];
  return res;
};

// 测试：this 应指向传入对象，参数 a、b 正常传递
function method(a, b) {
  console.log(this, a, b);
  return a + b;
}
method.myApply({}, [2, 3]);
