// 示例：异步流程、解构与可选链。
const inventory = [
  { name: "apple", stock: 12 },
  { name: "pear", stock: 0 },
];

async function fetchRestock(items) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return items
    .filter(({ stock }) => stock === 0)
    .map(({ name }) => name.toUpperCase());
}

export async function main() {
  const restock = await fetchRestock(inventory);
  for (const name of restock) {
    console.log(`需要补货：${name}`);
  }
  return restock.length;
}

main().catch((error) => console.error(error));
