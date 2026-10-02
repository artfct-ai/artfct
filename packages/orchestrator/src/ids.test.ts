import { describe, expect, it } from "bun:test";
import {
  branchName,
  jobId,
  jobIdFromBranch,
  newPersonId,
  newToken,
  newWorkflowId,
  sequenceFromJobId,
  slugify,
  taskId,
  workflowIdFromTaskId,
} from "./ids";

describe("id generators", () => {
  it("builds a prefixed base32 workflow id", () => {
    expect(newWorkflowId()).toMatch(/^wf_[a-z2-7]{10}$/);
  });

  it("builds a prefixed base32 person id", () => {
    expect(newPersonId()).toMatch(/^p_[a-z2-7]{10}$/);
  });

  it("builds a base32 token with no prefix", () => {
    expect(newToken()).toMatch(/^[a-z2-7]{32}$/);
  });

  it("does not repeat an id", () => {
    expect(newWorkflowId()).not.toBe(newWorkflowId());
  });
});

describe("taskId", () => {
  describe("a task id built from a workflow id and a sequence", () => {
    const id = taskId("wf_abcdefghij", 3);

    it("joins them with a dot", () => {
      expect(id).toBe("wf_abcdefghij.3");
    });

    it("gives the workflow id back", () => {
      expect(workflowIdFromTaskId(id)).toBe("wf_abcdefghij");
    });
  });

  describe("text that is not a task id", () => {
    it("rejects a workflow id on its own", () => {
      expect(workflowIdFromTaskId("wf_abcdefghij")).toBeNull();
    });

    it("rejects another prefix", () => {
      expect(workflowIdFromTaskId("p_abcdefghij.1")).toBeNull();
    });

    it("rejects a sequence that is not a number", () => {
      expect(workflowIdFromTaskId("wf_abc.x")).toBeNull();
    });
  });
});

describe("jobId", () => {
  describe("a job id built from a workflow id and a sequence", () => {
    const id = jobId("wf_abcdefghij", 3);

    it("joins them with a dash", () => {
      expect(id).toBe("wf_abcdefghij-3");
    });

    it("gives the sequence back", () => {
      expect(sequenceFromJobId(id)).toBe(3);
    });
  });

  describe("text that is not a job id", () => {
    it("has no sequence for a task id", () => {
      expect(sequenceFromJobId("wf_abcdefghij.3")).toBeNull();
    });

    it("has no sequence that is not a number", () => {
      expect(sequenceFromJobId("wf_abc-x")).toBeNull();
    });
  });
});

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Fix the Login Bug!")).toBe("fix-the-login-bug");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("--Hello, World--")).toBe("hello-world");
  });

  describe("a cap on the length", () => {
    it("cuts at the last whole word", () => {
      expect(slugify("aaaa bbbb cccc", 9)).toBe("aaaa-bbbb");
    });

    it("does not end in a dash", () => {
      expect(slugify("aaaa bbbb cccc", 10)).toBe("aaaa-bbbb");
    });
  });

  describe("text with nothing to slug", () => {
    it("falls back to task for punctuation", () => {
      expect(slugify("!!!")).toBe("task");
    });

    it("falls back to task for an empty string", () => {
      expect(slugify("")).toBe("task");
    });
  });
});

describe("branchName", () => {
  describe("a branch built from a job id and a title", () => {
    const id = jobId("wf_abcdefghij", 3);
    const branch = branchName(id, "Fix the Login Bug!");

    it("carries our prefix, the job id, and the slug", () => {
      expect(branch).toBe("artfct/wf_abcdefghij-3-fix-the-login-bug");
    });

    it("gives the job id back", () => {
      expect(jobIdFromBranch(branch)).toBe(id);
    });
  });

  describe("a branch that is not ours", () => {
    it("rejects the trunk", () => {
      expect(jobIdFromBranch("main")).toBeNull();
    });

    it("rejects our prefix with no sequence", () => {
      expect(jobIdFromBranch("artfct/wf_abcdefghij-fix")).toBeNull();
    });

    it("rejects the retired ao prefix", () => {
      expect(jobIdFromBranch("ao/wf_abcdefghij-3-fix")).toBeNull();
    });

    it("rejects another prefix", () => {
      expect(jobIdFromBranch("feature/wf_abcdefghij-3-fix")).toBeNull();
    });
  });
});
