// 零依赖测试运行器：所有用例串行执行，避免共享服务的状态串扰。
let passed = 0, failed = 0;
const failures = [];
let chain = Promise.resolve();

export function test(name, fn) {
  chain = chain
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((e) => {
      failed++;
      failures.push({ name, error: e });
      console.log(`  ✗ ${name}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ')}`);
    });
  return chain;
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? '断言失败');
}
export function approx(a, b, eps = 1e-6) {
  if (Math.abs(a - b) > eps) throw new Error(`期望 ${b}，实际 ${a}`);
}

export async function summary() {
  await chain;
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed) process.exitCode = 1;
  return failed;
}
