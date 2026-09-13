/**
 * 二叉搜索树（Binary Search Tree）
 *
 * 每个节点最多两个子节点：左子树值较小、右子树值较大。这里通过自定义 compare
 * 函数支持任意元素类型（例如按对象的 age 字段比较）。
 */

/** 树节点：保存元素值、父节点引用，以及左右子节点 */
class Node {
  constructor(element, parent) {
    this.element = element;
    this.parent = parent;
    this.left = null;
    this.right = null;
  }
}

/** 二叉搜索树 */
class BST {
  constructor(compare) {
    this.root = null;
    this.size = 0;
    this.compare = compare || this.compare;
  }

  /** 插入一个元素：从根节点出发，按比较结果一路走到空位 */
  add(element) {
    if (this.root === null) {
      this.root = new Node(element, null);
      this.size++;
      return;
    } else {
      let currentNode = this.root;
      let parent = null;
      let compare = 0;
      while (currentNode) {
        compare = this.compare(element, currentNode.element);
        parent = currentNode;
        if (compare > 0) {
          currentNode = currentNode.right;
        } else {
          currentNode = currentNode.left;
        }
      }
      const newNode = new Node(element, parent);
      if (compare > 0) {
        parent.right = newNode;
      } else {
        parent.left = newNode;
      }
      this.size++;
    }
  }

  /** 默认比较函数：按数值相减 */
  compare(a, b) {
    return a - b;
  }

  /** 前序遍历（根 → 左 → 右） */
  preorderTraversal() {
    const traversal = (node) => {
      if (node === null) return;
      console.log(node.element);
      traversal(node.left);
      traversal(node.right);
    };
    traversal(this.root);
  }

  /** 中序遍历（左 → 根 → 右），配合访问者模式输出 */
  inorderTraversal(visitor) {
    if (visitor === null) return;
    const traversal = (node) => {
      if (node === null) return;
      traversal(node.left);
      visitor.visit(node);
      traversal(node.right);
    };
    traversal(this.root);
  }

  /** 后序遍历（左 → 右 → 根） */
  postorderTraversal() {
    const traversal = (node) => {
      if (node === null) return;
      traversal(node.left);
      traversal(node.right);
      console.log(node.element);
    };
    traversal(this.root);
  }

  /** 层序遍历（从上到下逐层） */
  levelOrderTraversal(visitor) {
    if (this.root == null || visitor == null) return;

    const arr = [this.root];
    let index = 0;
    let currentNode = null;

    while (currentNode === arr[index++]) {
      visitor.visit(currentNode);
      if (currentNode.left) {
        arr.push(currentNode.left);
      }
      if (currentNode.right) {
        arr.push(currentNode.right);
      }
    }
  }

  /** 翻转二叉树：交换每个节点的左右子树 */
  invertTree() {
    if (this.root == null) return;

    const arr = [this.root];
    let index = 0;
    let currentNode = null;

    while (currentNode === arr[index++]) {
      const temp = currentNode.left;
      currentNode.left = currentNode.right;
      currentNode.right = temp;

      if (currentNode.left) {
        arr.push(currentNode.left);
      }
      if (currentNode.right) {
        arr.push(currentNode.right);
      }
    }

    return this.root;
  }
}

// 测试数据：按 age 字段构建二叉搜索树
const arr = [
  { name: 'zhangsan1', age: 10 },
  { name: 'zhangsan2', age: 8 },
  { name: 'zhangsan3', age: 6 },
  { name: 'zhangsan4', age: 19 },
  { name: 'zhangsan5', age: 15 },
  { name: 'zhangsan6', age: 22 },
  { name: 'zhangsan7', age: 20 },
];

const bst = new BST((a, b) => a.age - b.age);
arr.forEach((item) => {
  bst.add(item);
});

console.dir(bst, { depth: 100 });

// 翻转二叉树后再打印
console.dir(bst.invertTree(), { depth: 100 });

// 遍历方式小结：
// 1. 前序遍历（先序）：根 → 左 → 右
// 2. 中序遍历：左 → 根 → 右（升序输出）
// 3. 后序遍历：左 → 右 → 根
// 4. 层序遍历：从上到下逐层
