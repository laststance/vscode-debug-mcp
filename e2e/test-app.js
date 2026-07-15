// Simple test application for debugging verification
function add(a, b) {
  const result = a + b;
  return result;
}

function multiply(a, b) {
  const result = a * b;
  return result;
}

function main() {
  const x = 10;
  const y = 20;
  const sum = add(x, y);
  const product = multiply(x, y);
  const data = { sum, product, items: [1, 2, 3] };
  console.log("Sum:", sum);
  console.log("Product:", product);
  console.log("Data:", JSON.stringify(data));
}

main();
