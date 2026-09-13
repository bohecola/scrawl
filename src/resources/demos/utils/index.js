/**
 * 深拷贝
 *
 * 递归处理嵌套对象：基本类型直接返回，对象按原构造器新建实例并逐属性拷贝。
 */
export function cloneDeep(origin) {
  if (origin == undefined || typeof origin !== 'object') {
    return origin;
  }

  const target = new origin.constructor();

  for (const key in origin) {
    if (origin.hasOwnProperty(key)) {
      target[key] = cloneDeep(origin[key]);
    }
  }

  return target;
}

/**
 * 数组扁平化（一层）
 *
 * 只要数组里还含数组，就不断用 concat 展开一层，直到全部为普通元素。
 */
export function flat1(arr) {
  while (arr.some(Array.isArray)) {
    arr = [].concat(...arr);
  }
  return arr;
}

/**
 * 数组扁平化（完全展开 · 递归）
 *
 * 用 reduce 逐项累加：遇数组递归扁平化，否则直接加入结果。
 */
export function flat2(arr) {
  return arr.reduce((prev, item) => {
    return prev.concat(Array.isArray(item) ? flat2(item) : item);
  }, []);
}

/**
 * 快速排序（递归）
 *
 * 取一个基准值，把比它小的放左边、比它大的放右边，再对左右递归排序。
 */
export function quickSort() {
  if (arr.length < 1) return arr;
  const pivotIdx = Math.floor(arr.length / 2);
  const pivot = arr.splice(pivotIdx, 1)[0];

  const left = [];
  const right = [];

  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < pivot) {
      left.push(arr[i]);
    } else {
      right.push(arr[i]);
    }
  }

  return quickSort(left).concat(pivot, quickSort(right));
}

/**
 * 冒泡排序
 *
 * 每轮把相邻较大的元素往右交换，下一轮待比较范围缩小一位。
 */
export function bubbleSort(arr) {
  for (let i = 0; i < arr.length - 1; i++) {
    for (let j = 0; j < arr.length - 1 - i; j++) {
      if (arr[j] > arr[j + 1]) {
        const temp = arr[j];
        arr[j] = arr[j + 1];
        arr[j + 1] = temp;
      }
    }
  }
  return arr;
}
