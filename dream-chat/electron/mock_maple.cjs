class MockMapleActionSource {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
  }

  async next(prompt) {
    this.calls.push(prompt);
    if (!this.responses.length) throw new Error("Mock Maple action sequence exhausted.");
    const response = this.responses.shift();
    return typeof response === "function" ? response(prompt, this.calls.length) : response;
  }
}

function createMockMapleActionSource(responses) {
  const source = new MockMapleActionSource(responses);
  return { source, inferAction: (prompt) => source.next(prompt) };
}

module.exports = { MockMapleActionSource, createMockMapleActionSource };
