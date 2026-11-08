import assert from "node:assert/strict";
import test from "node:test";
import { markdownUrlTransform } from "./markdown";
import { isReadableInternalUrl } from "./internal-url-web";

for (const scheme of ["agent", "artifact", "local", "memory", "issue", "pr", "skill", "rule", "omp"]) {
  test(`recognizes read-only ${scheme} links`, () => {
    assert.equal(isReadableInternalUrl(`${scheme}://resource`), true);
    assert.equal(isReadableInternalUrl(`${scheme.toUpperCase()}://resource`), true);
  });
}

test("rejects execution, secret, remote and unknown protocols", () => {
  for (const value of ["ssh://x/y", "xd://bash", "cfg://", "vault://", "mcp://resource", "proc://1", "javascript:alert(1)", "data:text/html,test", "https://example.com", "unknown://x", "toString://x", "constructor://x"]) {
    assert.equal(isReadableInternalUrl(value), false, value);
  }
});

test("requires one complete URL without whitespace or control characters", () => {
  for (const value of [undefined, null, "", " local://x", "local://x ", "local://x\n", "local://x other", "local:/x", "local://x\u0000", "local://x\u007f"]) {
    assert.equal(isReadableInternalUrl(value), false, String(value));
  }
  assert.equal(isReadableInternalUrl("local://plan.md:1-20"), true);
  assert.equal(isReadableInternalUrl("issue://12?state=open"), true);
});

test("markdown URL transform preserves internal hrefs and filters unsafe URLs", () => {
  for (const scheme of ["agent", "artifact", "local", "memory", "issue", "pr", "skill", "rule", "omp"]) {
    const url = `${scheme}://resource`;
    assert.equal(markdownUrlTransform(url, "href"), url);
    assert.equal(markdownUrlTransform(url, "src"), "");
  }
  assert.equal(markdownUrlTransform("https://example.com", "href"), "https://example.com");
  assert.equal(markdownUrlTransform("javascript:alert(1)", "href"), "");
  assert.equal(markdownUrlTransform("data:text/html,test", "href"), "");
});
