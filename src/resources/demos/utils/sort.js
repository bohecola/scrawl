/**
 * 冒泡排序
 *
 * 每轮把相邻较大的元素往右交换，下一轮待比较范围缩小一位。
 */
function bubbleSort(arr) {
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

/**
 * 插入排序
 *
 * 维护左侧已排序区，每轮取出当前元素，从右往左找到合适位置插入。
 */
function insertionSort(arr) {
  let preIndex, current;
  for (let i = 1; i < arr.length; i++) {
    preIndex = i - 1;
    current = arr[i];
    while (preIndex >= 0 && arr[preIndex] > current) {
      arr[preIndex + 1] = arr[preIndex];
      preIndex--;
    }
    arr[preIndex + 1] = current;
  }
  return arr;
}

/**
 * 选择排序
 *
 * 每轮在未排序区找到最小值，与当前轮起始位置交换。
 */
function selectionSort(arr) {
  let minIdx, temp;
  for (let i = 0; i < arr.length - 1; i++) {
    minIdx = i;
    for (let j = i + 1; j < arr.length; j++) {
      if (arr[j] < arr[minIdx]) {
        minIdx = j;
      }
    }
    temp = arr[i];
    arr[i] = arr[minIdx];
    arr[minIdx] = temp;
  }
  return arr;
}

/**
 * 归并排序
 *
 * 不断对半拆分到不可再分，再合并两个有序子数组。
 */
function mergeSort(arr) {
  if (arr.length < 2) {
    return arr;
  }
  const middle = Math.floor(arr.length / 2);
  const left = arr.slice(0, middle);
  const right = arr.slice(middle);
  return merge(mergeSort(left), mergeSort(right));
}

/** 合并两个有序数组为一个有序数组 */
function merge(left, right) {
  const result = [];

  while (left.length && right.length) {
    if (left[0] <= right[0]) {
      result.push(left.shift());
    } else {
      result.push(right.shift());
    }
  }

  while (left.length) result.push(left.shift());
  while (right.length) result.push(right.shift());

  return result;
}

/**
 * 快速排序（递归 · 原地分区）
 *
 * 选取基准值，把小于它的放左侧、大于它的放右侧，再对两侧递归排序。
 */
function quickSort(arr, left, right) {
  let len = arr.length;
  let partitionIndex;
  left = typeof left !== 'number' ? 0 : left;
  right = typeof right !== 'number' ? len - 1 : right;

  if (left < right) {
    partitionIndex = partition(arr, left, right);
    quickSort(arr, left, partitionIndex - 1);
    quickSort(arr, partitionIndex + 1, right);
  }
  return arr;
}

/** 分区操作（Lomuto）：以左端为基准，把小于基准的元素移到左边 */
function partition(arr, left, right) {
  let pivot = left; // 基准值下标
  let index = pivot + 1;
  for (let i = index; i <= right; i++) {
    if (arr[i] < arr[pivot]) {
      swap(arr, i, index);
      index++;
    }
  }
  swap(arr, pivot, index - 1);
  return index - 1;
}

/** 交换数组中 i、j 两个位置的元素 */
function swap(arr, i, j) {
  const temp = arr[i];
  arr[i] = arr[j];
  arr[j] = temp;
}
