const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mapleDesktop", {
  isDesktop: true,
  providers: {
    status: () => ipcRenderer.invoke("providers:status"),
    login: (provider) => ipcRenderer.invoke("providers:login", provider),
    logout: (provider) => ipcRenderer.invoke("providers:logout", provider),
  },
  maple: {
    launch: () => ipcRenderer.invoke("maple:launch"),
  },
  agent: {
    getState: () => ipcRenderer.invoke("agent:state"),
    submitIntent: (input = {}) => ipcRenderer.invoke("agent:intent", input),
    threads: (action = "list", input = {}) => ipcRenderer.invoke("agent:threads", { action, ...input }),
    projects: (action = "list", input = {}) => ipcRenderer.invoke("agent:projects", { action, ...input }),
    suggestions: (action = "list", input = {}) => ipcRenderer.invoke("agent:suggestions", { action, ...input }),
    proposePlan: (taskId, input = {}) => ipcRenderer.invoke("agent:plan", { action: "propose", taskId, ...input }),
    approvePlan: (taskId, planId) => ipcRenderer.invoke("agent:plan", { action: "approve", taskId, planId }),
    rejectPlan: (taskId, planId, reason = "Rejected by user") => ipcRenderer.invoke("agent:plan", { action: "reject", taskId, planId, reason }),
    resumeTask: (taskId) => ipcRenderer.invoke("agent:command", { action: "task.resume", taskId }),
    runCommand: (commandId, input = {}) => ipcRenderer.invoke("agent:command", { action: commandId, ...input }),
    acceptAction: (taskId, actionId) => ipcRenderer.invoke("agent:command", { action: "action.accept", taskId, actionId }),
    rejectAction: (taskId, actionId, reason = "Rejected by user") => ipcRenderer.invoke("agent:command", { action: "action.reject", taskId, actionId, reason }),
    acceptCandidate: (candidateId) => ipcRenderer.invoke("agent:candidate", { action: "accept", candidateId }),
    dismissCandidate: (candidateId) => ipcRenderer.invoke("agent:candidate", { action: "dismiss", candidateId }),
    approveChangeSet: (taskId, changeSetId) => ipcRenderer.invoke("agent:changeset", { action: "approve", taskId, changeSetId, confirm: true }),
    rejectChangeSet: (taskId, changeSetId, note = "Rejected by user") => ipcRenderer.invoke("agent:changeset", { action: "reject", taskId, changeSetId, note }),
    cancel: (taskId) => ipcRenderer.invoke("agent:cancel", taskId),
    cancelQueued: (requestId) => ipcRenderer.invoke("agent:queue-cancel", requestId),
    artifacts: (action, input = {}) => ipcRenderer.invoke("agent:artifacts", { action, input }),
    preview: (action, input = {}) => ipcRenderer.invoke("agent:preview", { action, input }),
    reportPreview: (report = {}) => ipcRenderer.invoke("agent:preview-report", report),
    subscribeStream: (callback) => {
      const listener = (_event, frame) => callback(frame);
      ipcRenderer.on("agent:stream", listener);
      return () => ipcRenderer.removeListener("agent:stream", listener);
    },
    subscribe: (callback) => {
      const listener = (_event, event) => callback(event);
      ipcRenderer.on("agent:event", listener);
      return () => ipcRenderer.removeListener("agent:event", listener);
    },
    memory: (action, input = {}) => ipcRenderer.invoke("agent:command", { action: `memory.${action}`, ...input }),
    context: {
      query: (input = {}) => ipcRenderer.invoke("agent:command", { action: "context.query", ...input }),
    },
    sources: {
      getState: () => ipcRenderer.invoke("agent:sources", { action: "get" }),
      setPolicy: (sourceId, policy = {}) => ipcRenderer.invoke("agent:sources", { action: "set-policy", sourceId, policy }),
    },
    training: (action, input = {}) => ipcRenderer.invoke("agent:command", { action: `training.${action}`, ...input }),
    receipts: {
      query: (input = {}) => ipcRenderer.invoke("agent:receipts", input),
    },
    windows: (action, input = {}) => ipcRenderer.invoke("agent:windows", { action, input }),
  },
  getAgentState() {
    return ipcRenderer.invoke("agent:state");
  },
  submitIntent(payload = {}) {
    return ipcRenderer.invoke("agent:intent", payload);
  },
  threads(action = "list", input = {}) {
    return ipcRenderer.invoke("agent:threads", { action, ...input });
  },
  projects(action = "list", input = {}) {
    return ipcRenderer.invoke("agent:projects", { action, ...input });
  },
  suggestions(action = "list", input = {}) {
    return ipcRenderer.invoke("agent:suggestions", { action, ...input });
  },
  updateAgentTask(payload) {
    return ipcRenderer.invoke("agent:task", payload);
  },
  emitAgentEvent(payload) {
    return ipcRenderer.invoke("agent:event", payload);
  },
  agentCommand(action, payload = {}) {
    return ipcRenderer.invoke("agent:command", { action, ...payload });
  },
  acceptCandidate(candidateId) {
    return ipcRenderer.invoke("agent:candidate", { action: "accept", candidateId });
  },
  dismissCandidate(candidateId) {
    return ipcRenderer.invoke("agent:candidate", { action: "dismiss", candidateId });
  },
  approveChangeSet(taskId, changeSetId) {
    return ipcRenderer.invoke("agent:changeset", { action: "approve", taskId, changeSetId, confirm: true });
  },
  rejectChangeSet(taskId, changeSetId, note) {
    return ipcRenderer.invoke("agent:changeset", { action: "reject", taskId, changeSetId, note });
  },
  queryContext(input = {}) {
    return ipcRenderer.invoke("agent:command", { action: "context.query", ...input });
  },
  getSources() {
    return ipcRenderer.invoke("agent:sources", { action: "get" });
  },
  setSourcePolicy(sourceId, policy = {}) {
    return ipcRenderer.invoke("agent:sources", { action: "set-policy", sourceId, policy });
  },
  queryReceipts(input = {}) {
    return ipcRenderer.invoke("agent:receipts", input);
  },
  recordMemory(payload) {
    return ipcRenderer.invoke("agent:memory", payload);
  },
  windows(action, input = {}) {
    return ipcRenderer.invoke("agent:windows", { action, input });
  },
  cancelAgentTask() {
    return ipcRenderer.invoke("agent:cancel");
  },
  cancelQueuedIntent(requestId) {
    return ipcRenderer.invoke("agent:queue-cancel", requestId);
  },
  artifacts(action, input = {}) {
    return ipcRenderer.invoke("agent:artifacts", { action, input });
  },
  preview(action, input = {}) {
    return ipcRenderer.invoke("agent:preview", { action, input });
  },
  reportPreview(report = {}) {
    return ipcRenderer.invoke("agent:preview-report", report);
  },
  subscribeStream(callback) {
    const listener = (_event, frame) => callback(frame);
    ipcRenderer.on("agent:stream", listener);
    return () => ipcRenderer.removeListener("agent:stream", listener);
  },
  onAgentEvent(callback) {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  startDream(payload) {
    return ipcRenderer.invoke("dream:start", payload);
  },
  launchMaple() {
    return ipcRenderer.invoke("maple:launch");
  },
  onDreamProgress(callback) {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("dream:progress", listener);
    return () => ipcRenderer.removeListener("dream:progress", listener);
  },
  sipsCommand(action, payload = {}) {
    return ipcRenderer.invoke("sips:command", { action, ...payload });
  },
  runSipsCycle(payload) {
    return ipcRenderer.invoke("sips:cycle", payload);
  },
  onSipsProgress(callback) {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("sips:progress", listener);
    return () => ipcRenderer.removeListener("sips:progress", listener);
  },
});

contextBridge.exposeInMainWorld("hemlockAgent", {
  providers: {
    status: () => ipcRenderer.invoke("providers:status"),
    login: (provider) => ipcRenderer.invoke("providers:login", provider),
    logout: (provider) => ipcRenderer.invoke("providers:logout", provider),
  },
  maple: {
    launch: () => ipcRenderer.invoke("maple:launch"),
  },
  getState: () => ipcRenderer.invoke("agent:state"),
  submitIntent: (input = {}) => ipcRenderer.invoke("agent:intent", input),
  threads: (action = "list", input = {}) => ipcRenderer.invoke("agent:threads", { action, ...input }),
  projects: (action = "list", input = {}) => ipcRenderer.invoke("agent:projects", { action, ...input }),
  suggestions: (action = "list", input = {}) => ipcRenderer.invoke("agent:suggestions", { action, ...input }),
  proposePlan: (taskId, input = {}) => ipcRenderer.invoke("agent:plan", { action: "propose", taskId, ...input }),
  approvePlan: (taskId, planId) => ipcRenderer.invoke("agent:plan", { action: "approve", taskId, planId }),
  rejectPlan: (taskId, planId, reason = "Rejected by user") => ipcRenderer.invoke("agent:plan", { action: "reject", taskId, planId, reason }),
  resumeTask: (taskId) => ipcRenderer.invoke("agent:command", { action: "task.resume", taskId }),
  runCommand: (commandId, input = {}) => ipcRenderer.invoke("agent:command", { action: commandId, ...input }),
  acceptAction: (taskId, actionId) => ipcRenderer.invoke("agent:command", { action: "action.accept", taskId, actionId }),
  rejectAction: (taskId, actionId, reason = "Rejected by user") => ipcRenderer.invoke("agent:command", { action: "action.reject", taskId, actionId, reason }),
  acceptCandidate: (candidateId) => ipcRenderer.invoke("agent:candidate", { action: "accept", candidateId }),
  dismissCandidate: (candidateId) => ipcRenderer.invoke("agent:candidate", { action: "dismiss", candidateId }),
  approveChangeSet: (taskId, changeSetId) => ipcRenderer.invoke("agent:changeset", { action: "approve", taskId, changeSetId, confirm: true }),
  rejectChangeSet: (taskId, changeSetId, note = "Rejected by user") => ipcRenderer.invoke("agent:changeset", { action: "reject", taskId, changeSetId, note }),
  cancel: (taskId) => ipcRenderer.invoke("agent:cancel", taskId),
  cancelQueued: (requestId) => ipcRenderer.invoke("agent:queue-cancel", requestId),
  artifacts: (action, input = {}) => ipcRenderer.invoke("agent:artifacts", { action, input }),
  preview: (action, input = {}) => ipcRenderer.invoke("agent:preview", { action, input }),
  reportPreview: (report = {}) => ipcRenderer.invoke("agent:preview-report", report),
  subscribeStream: (callback) => {
    const listener = (_event, frame) => callback(frame);
    ipcRenderer.on("agent:stream", listener);
    return () => ipcRenderer.removeListener("agent:stream", listener);
  },
  subscribe: (callback) => {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  memory: (action, input = {}) => ipcRenderer.invoke("agent:command", { action: `memory.${action}`, ...input }),
  context: { query: (input = {}) => ipcRenderer.invoke("agent:command", { action: "context.query", ...input }) },
  sources: {
    getState: () => ipcRenderer.invoke("agent:sources", { action: "get" }),
    setPolicy: (sourceId, policy = {}) => ipcRenderer.invoke("agent:sources", { action: "set-policy", sourceId, policy }),
  },
  training: (action, input = {}) => ipcRenderer.invoke("agent:command", { action: `training.${action}`, ...input }),
  receipts: { query: (input = {}) => ipcRenderer.invoke("agent:receipts", input) },
  windows: (action, input = {}) => ipcRenderer.invoke("agent:windows", { action, input }),
  launchMaple: () => ipcRenderer.invoke("maple:launch"),
});
