import { describe, expect, it } from "vitest";
import { base64, base64url } from "../src/encoding.ts";
import {
  CREATE_COMMIT_MUTATION,
  createCommitInput,
  graphqlRequest,
  installationTokenRequest,
  readFilesQuery,
} from "../src/github.ts";
import { decodeBase64Text } from "./helpers.ts";

const encode = (text: string) => new TextEncoder().encode(text);

function expectGitHubHeaders(request: Request, authorization: string) {
  expect(request.method).toBe("POST");
  expect(request.headers.get("authorization")).toBe(authorization);
  expect(request.headers.get("accept")).toBe("application/vnd.github+json");
  expect(request.headers.get("x-github-api-version")).toBe("2022-11-28");
  expect(request.headers.get("user-agent")).toBe("kelpie-spike-github-commit");
  expect(request.headers.get("content-type")).toBe("application/json");
}

describe("base64 encodings", () => {
  it("keeps + / and padding in file contents, and drops them in JWT segments", () => {
    expect(base64(encode("~~~"))).toBe("fn5+");
    expect(base64(encode("???"))).toBe("Pz8/");
    expect(base64(encode("a"))).toBe("YQ==");
    expect(base64url(encode("~~~"))).toBe("fn5-");
    expect(base64url(encode("???"))).toBe("Pz8_");
    expect(base64url(encode("a"))).toBe("YQ");
  });
});

describe("installationTokenRequest", () => {
  it("posts the App JWT to the installation's access_tokens endpoint, narrowed to the test repo", async () => {
    const request = installationTokenRequest("header.payload.signature", "167691807", "repo");

    expect(request.url).toBe("https://api.github.com/app/installations/167691807/access_tokens");
    expectGitHubHeaders(request, "Bearer header.payload.signature");
    expect(await request.json()).toEqual({ repositories: ["repo"] });
  });
});

describe("createCommitOnBranch request", () => {
  it("sends one mutation with the branch, expectedHeadOid, base64 additions and deletions", async () => {
    const request = graphqlRequest("ghs_test", CREATE_COMMIT_MUTATION, {
      input: createCommitInput({
        repository: "guedesdiogo/kelpie-context-test",
        branch: "main",
        expectedHeadOid: "0123456789abcdef0123456789abcdef01234567",
        headline: "spike: two files",
        additions: [
          { path: "run/a.md", contents: "~~~" },
          { path: "run/b.md", contents: "Olá, ✓" },
        ],
        deletions: ["run/old.md"],
      }),
    });

    expect(request.url).toBe("https://api.github.com/graphql");
    expectGitHubHeaders(request, "Bearer ghs_test");
    const body = (await request.json()) as {
      query: string;
      variables: { input: { fileChanges: { additions: { contents: string }[] } } };
    };
    expect(body.query).toBe(CREATE_COMMIT_MUTATION);
    expect(body.variables.input).toEqual({
      branch: { repositoryNameWithOwner: "guedesdiogo/kelpie-context-test", branchName: "main" },
      message: { headline: "spike: two files" },
      expectedHeadOid: "0123456789abcdef0123456789abcdef01234567",
      fileChanges: {
        additions: [
          { path: "run/a.md", contents: "fn5+" },
          { path: "run/b.md", contents: base64(encode("Olá, ✓")) },
        ],
        deletions: [{ path: "run/old.md" }],
      },
    });
    expect(decodeBase64Text(body.variables.input.fileChanges.additions[1]?.contents ?? "")).toBe(
      "Olá, ✓",
    );
  });

  it("leaves out an empty list of additions or deletions", () => {
    const input = createCommitInput({
      repository: "o/r",
      branch: "main",
      expectedHeadOid: "abc",
      headline: "h",
      deletions: ["gone.md"],
    });

    expect(input.fileChanges).toEqual({ deletions: [{ path: "gone.md" }] });
  });
});

describe("readFilesQuery", () => {
  it("aliases one blob lookup per expression", () => {
    const query = readFilesQuery(2);

    expect(query).toContain("$e0: String!, $e1: String!");
    expect(query).toContain("f0: object(expression: $e0) { ... on Blob { text } }");
    expect(query).toContain("f1: object(expression: $e1) { ... on Blob { text } }");
  });
});
