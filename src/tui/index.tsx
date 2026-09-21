/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, For, Show, onMount, onCleanup } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { stringWidth } from "bun"
import type { BoxRenderable, ScrollBoxRenderable, SelectRenderable } from "@opentui/core"
import { adjacentCommand, outputScreenMove, commandSource, commandOutput, commandPreview, commandListItem, outputPage, navigateTask, projectTaskOverview, registerTaskOverview, registerTaskListPaging, taskNavigationTarget } from "./task-overview.mjs"
import { projectWorkflowOverview, workflowEnabled, workflowSidebar, workflowPage, workflowListItem, registerTuiOverviewCommands } from "./workflow-overview.mjs"
import { runtimeWorkflowOptions } from "./workflow-options.mjs"

type ViewProps = { api: TuiPluginApi; session_id: string; workflowEnabled?: boolean }
const currentOwner = (props: ViewProps) => props.api.route.current.name === "session"
  && props.api.route.current.params?.sessionID === props.session_id
const getSession = (props: ViewProps) => (id: string) => currentOwner(props) ? props.api.state.session.get(id) : undefined
const taskView = (props: ViewProps, extra = {}) => projectTaskOverview({ sessionID: props.session_id, getSession: getSession(props), ...extra })
const workflowView = (props: ViewProps) => projectWorkflowOverview({ sessionID: props.session_id, getSession: getSession(props), enabled: props.workflowEnabled })
const errorStatus = (status: string) => ["failed", "unknown", "interrupted"].includes(status)
type DetailProps = ViewProps & { taskID: string; kind: string; back?: () => void }
type Action = { name: string; run: () => void }

// A real focusable selection, not clickable text masquerading as buttons.
function Actions(props: { api: TuiPluginApi; items: Action[]; focused?: boolean; onTab?: () => void; shortcuts?: Record<string, () => void> }) {
  let menu: SelectRenderable | undefined
  return <select ref={(value) => { menu = value }} height={props.items.length} focused={props.focused ?? true}
    options={props.items.map((item) => ({ name: item.name, description: "", value: item.run }))}
    showDescription={false} wrapSelection
    backgroundColor={props.api.theme.current.backgroundPanel} focusedBackgroundColor={props.api.theme.current.backgroundPanel}
    textColor={props.api.theme.current.text} focusedTextColor={props.api.theme.current.text}
    selectedBackgroundColor={props.api.theme.current.primary} selectedTextColor={props.api.theme.current.selectedListItemText}
    onKeyDown={(event) => {
      if (props.shortcuts?.[event.name]) {
        event.preventDefault(); event.stopPropagation(); props.shortcuts[event.name](); return
      }
      if (event.name !== "tab") return
      event.preventDefault()
      event.stopPropagation()
      if (props.onTab) props.onTab()
      else if (event.shift) menu?.moveUp()
      else menu?.moveDown()
    }} onMouseUp={(event) => {
      if (!menu) return
      const index = event.y - menu.y
      if (index < 0 || index >= props.items.length) return
      event.stopPropagation()
      menu.setSelectedIndex(index)
      props.items[index].run()
    }} onSelect={(_, option) => option?.value?.()} />
}

function BashOutput(props: DetailProps) {
  const dimensions = useTerminalDimensions()
  let panel: BoxRenderable | undefined
  let output: ScrollBoxRenderable | undefined
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  const [result, setResult] = createSignal<{ output?: string; unavailable?: string; incomplete?: boolean }>({})
  const [loading, setLoading] = createSignal(false)
  const [loadedSource, setLoadedSource] = createSignal("")
  const [page, setPage] = createSignal(0)
  const row = createMemo(() => taskView(props, { taskID: props.taskID }).groups.flatMap((group) => group.rows)[0])
  const source = () => commandSource({ sessionID: props.session_id, taskID: props.taskID, getSession: getSession(props) })
  const content = createMemo(() => currentOwner(props) && source() && (!loadedSource() || loadedSource() === JSON.stringify(source())) ? result() : { unavailable: "Record unavailable / owner changed" })
  const chunk = createMemo(() => outputPage(content().output ?? "", page()))
  let controller: AbortController | undefined
  let disposed = false
  onCleanup(() => { disposed = true; controller?.abort(); clearTimeout(scrollTimer) })
  const refresh = async () => {
    const origin = source()
    controller?.abort()
    if (!origin) { setResult({ unavailable: "Bash source unavailable" }); return }
    const request = new AbortController()
    controller = request
    setLoading(true)
    const timer = setTimeout(() => request.abort(), 10000)
    try {
      const response = await props.api.client.session.message({ sessionID: props.session_id, messageID: origin.messageID, directory: props.api.state.path.directory }, { signal: request.signal })
      if (disposed || controller !== request || !currentOwner(props) || JSON.stringify(source()) !== JSON.stringify(origin)) return
      setLoadedSource(JSON.stringify(origin))
      setResult(response.error ? { unavailable: "Unable to read Bash output; refresh to retry" } : commandOutput({ source: origin, taskID: props.taskID, message: response.data }))
    } catch {
      if (!disposed && controller === request) setResult({ unavailable: "Unable to read Bash output; refresh to retry" })
    } finally {
      clearTimeout(timer)
      if (!disposed && controller === request) setLoading(false)
    }
  }
  onMount(() => { props.api.ui.dialog.setSize("large"); void refresh() })
  const back = () => props.back ? props.back() : openTasks(props, "command", 0, props.taskID)
  const switchTask = (direction: number) => {
    const target = adjacentCommand({ sessionID: props.session_id, taskID: props.taskID, getSession: getSession(props), direction })
    if (!target) return
    props.api.ui.dialog.replace(() => <BashOutput api={props.api} session_id={props.session_id} kind="command" taskID={target.taskID}
      back={() => openTasks(props, "command", target.page, target.taskID)} />)
  }
  const turn = (direction: number) => {
    if (!output) return
    const move = outputScreenMove({ page: Math.min(page(), chunk().count - 1), count: chunk().count,
      top: output.scrollTop, height: output.scrollHeight, viewport: output.viewport.height, direction })
    setPage(move.page)
    clearTimeout(scrollTimer)
    if (move.top === "end") scrollTimer = setTimeout(() => output?.scrollTo(output.scrollHeight), 0)
    else output.scrollTo(move.top)
  }
  // Bind at the modal focus subtree before host/global key handlers, and dispose
  // with the panel. Page keys must never navigate/close the underlying session.
  onMount(() => {
    const dispose = props.api.keymap.registerLayer({ target: panel, targetMode: "focus-within", bindings: [
      { key: "up", cmd: () => turn(-1) }, { key: "down", cmd: () => turn(1) },
      { key: "pageup", cmd: () => turn(-1) }, { key: "pagedown", cmd: () => turn(1) },
      { key: "left", cmd: () => switchTask(-1) }, { key: "right", cmd: () => switchTask(1) },
    ] })
    onCleanup(dispose)
  })
  // dialog.replace already supplies the host Dialog; nesting another creates an off-screen overlay.
  return <box ref={(value) => { panel = value }} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={props.api.theme.current.text}><b>Bash #{row()?.sequence ?? "?"}</b> · {row()?.status ?? "unavailable"}{row()?.exitCode === undefined ? "" : ` · exit ${row().exitCode}`}</text>
        <text fg={props.api.theme.current.textMuted}>esc close</text>
      </box>
      <Show when={loading()}><text>Loading…</text></Show>
      <Show when={content().unavailable}><text fg={props.api.theme.current.error}>{content().unavailable}</text></Show>
      <Show when={content().incomplete}><text fg={props.api.theme.current.warning}>Host capture is incomplete; this is not the full output.</text></Show>
      <scrollbox ref={(value) => { output = value }} height={Math.max(3, Math.min(16, Math.floor(dimensions().height * 0.75) - 10, chunk().text.split("\n").length + 1))} focused
        onKeyDown={(event) => {
          const action = ({ r: () => void refresh(), b: back } as Record<string, () => void>)[event.name]
          if (action) { event.preventDefault(); event.stopPropagation(); action() }
        }}><text selectable>{content().output === "" ? "(empty output)" : chunk().text}</text></scrollbox>
      <text fg={props.api.theme.current.textMuted}>←→ task · ↑↓ screen · output {Math.min(page() + 1, chunk().count)}/{chunk().count}</text>
      <box flexDirection="row" gap={2}>
        <text fg={props.api.theme.current.primary} onMouseUp={() => void refresh()}>Refresh (r)</text>
        <text fg={props.api.theme.current.primary} onMouseUp={back}>Back (b)</text>
      </box>
    </box>
}

function TaskDetails(props: DetailProps) {
  const row = createMemo(() => taskView(props, { taskID: props.taskID }).groups.flatMap((group) => group.rows)[0])
  const target = createMemo(() => taskNavigationTarget({ sessionID: props.session_id, taskID: props.taskID, getSession: getSession(props) }))
  const back = () => props.back ? props.back() : openTasks(props, props.kind, 0, props.taskID)
  const open = () => {
    if (!navigateTask(props.api, props.session_id, props.taskID)) props.api.ui.toast({ variant: "warning", message: "Execution link unavailable; no navigation performed." })
  }
  onMount(() => props.api.ui.dialog.setSize("medium"))
  return <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
    <box flexDirection="row" justifyContent="space-between">
      <text fg={props.api.theme.current.text}><b>Subagent #{row()?.sequence ?? "?"}</b></text>
      <text fg={props.api.theme.current.textMuted}>esc close</text>
    </box>
    <box>
      <text fg={props.api.theme.current.text}>{row()?.label ?? "Record unavailable / owner changed"}</text>
      <text fg={errorStatus(row()?.status) ? props.api.theme.current.error : props.api.theme.current.primary}>{row()?.status ?? "unavailable"}{row()?.source === "unavailable" ? " · unavailable" : ""}</text>
      <Show when={row()?.phase && row()?.phase !== row()?.status}><text fg={props.api.theme.current.textMuted}>Phase · {row()?.phase}</text></Show>
      <Show when={target()}><text fg={props.api.theme.current.textMuted}>Permissions {props.api.state.session.permission(target()!).length} · Questions {props.api.state.session.question(target()!).length}</text></Show>
      <Show when={!target()}><text fg={props.api.theme.current.warning}>Execution Session unavailable</text></Show>
    </box>
    <Actions api={props.api} shortcuts={{ b: back, o: () => { if (target()) open() } }} items={[
      ...(target() ? [{ name: "Open execution session", run: open }] : []),
      { name: "Back to Subagents", run: back },
    ]} />
    <text fg={props.api.theme.current.textMuted}>↑↓ / tab select · enter open</text>
  </box>
}

function TaskList(props: ViewProps & { kind: string; page?: number; selected?: string }) {
  let panel: BoxRenderable | undefined
  const [width, setWidth] = createSignal(0)
  const [page, setPage] = createSignal(props.page ?? 0)
  const group = createMemo(() => taskView(props, { limit: 20, offset: page() * 20 }).groups.find((group) => group.kind === props.kind))
  const previews = createMemo(() => {
    const result = new Map<string, string>()
    if (props.kind !== "command" || !currentOwner(props)) return result
    const messages = props.api.state.session.messages(props.session_id)
    for (const row of group()?.rows ?? []) {
      const source = commandSource({ sessionID: props.session_id, taskID: row.id, getSession: getSession(props) })
      if (!source) continue
      const matches = messages.filter((info) => info.id === source.messageID)
      if (matches.length !== 1) continue
      const preview = commandPreview({ source, taskID: row.id, message: { info: matches[0], parts: props.api.state.part(source.messageID) } })
      if (preview) result.set(row.id, preview)
    }
    return result
  })
  onMount(() => {
    props.api.ui.dialog.setSize("large")
    setWidth(panel?.width ?? 0)
    onCleanup(registerTaskListPaging(props.api, panel, { page, total: () => group()?.allTotal ?? 0, setPage }))
  })
  const open = (row) => {
    const back = () => openTasks(props, props.kind, page(), row.id)
    props.api.ui.dialog.replace(() => row.kind === "command" ? <BashOutput {...props} taskID={row.id} back={back} /> : <TaskDetails {...props} taskID={row.id} back={back} />)
  }
  return <box ref={(value) => { panel = value }} onSizeChange={() => setWidth(panel?.width ?? 0)}><props.api.ui.DialogSelect flat current={props.selected} title={`${props.kind === "command" ? "Bash" : "Subagents"} · ${page() + 1}/${Math.max(1, Math.ceil((group()?.allTotal ?? 0) / 20))} · ←→ page`} options={[
    ...(group()?.rows ?? []).map((row) => ({ ...(row.kind === "command"
      // Scroll padding (2), row padding/marker (6), title padding (3), gap (1).
      // footer is a non-shrinking right column, never part of the truncated title.
      ? commandListItem({ row, rows: group()?.rows, preview: previews().get(row.id), columns: width() - 12, measure: stringWidth })
      : { title: `#${row.sequence || "?"}  ${row.label} · ${row.status}` }),
      description: row.kind === "command" ? undefined : [row.phase !== row.status ? row.phase : "", row.exitCode === undefined ? "" : `exit ${row.exitCode}`].filter(Boolean).join(" · "), value: row.id,
      onSelect: () => open(row) })),
    ...(!group()?.rows.length ? [{ title: "No records on this page / owner unavailable", value: "empty" }] : []),
    ...(group()?.invalid ? [{ title: "Some records unavailable", value: "invalid" }] : []),
  ]} /></box>
}
function openTasks(props: ViewProps, kind: string, page = 0, selected?: string) {
  props.api.ui.dialog.replace(() => <TaskList {...props} kind={kind} page={page} selected={selected} />)
}

function WorkflowDetails(props: ViewProps & { runID: string; listPage: number }) {
  const dimensions = useTerminalDimensions()
  let panel: BoxRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  const [page, setPage] = createSignal(0)
  const [focus, setFocus] = createSignal("steps")
  const row = createMemo(() => workflowView(props).rows.find((row) => row.id === props.runID))
  const steps = createMemo(() => workflowPage(row()?.steps ?? [], page()))
  const back = () => openWorkflows(props, props.listPage, props.runID)
  createEffect(() => { if (!currentOwner(props)) props.api.ui.dialog.clear() })
  createEffect(() => { steps().page; scroll?.scrollTo(0) })
  onMount(() => {
    props.api.ui.dialog.setSize("large")
    onCleanup(registerTaskListPaging(props.api, panel, { page: () => steps().page, total: () => row()?.total ?? 0, setPage }))
  })
  return <box ref={(value) => { panel = value }} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
    <box flexDirection="row" justifyContent="space-between">
      <text fg={props.api.theme.current.text}><b>Workflow · Beta</b></text>
      <text fg={props.api.theme.current.textMuted}>esc close</text>
    </box>
    <box>
      <text fg={props.api.theme.current.text}>{props.runID}</text>
      <Show when={row()?.source === "snapshot"}>
        <text fg={props.api.theme.current.text}>{row()?.workflow}</text>
        <text fg={row()?.status === "interrupted" ? props.api.theme.current.error : props.api.theme.current.text}>
          {row()?.status} · {row()?.passed}/{row()?.total} steps · r{row()?.revision}
        </text>
      </Show>
      <Show when={row()?.source !== "snapshot"}><text fg={props.api.theme.current.error}>unknown · checkpoint unavailable</text></Show>
    </box>
    <Show when={steps().rows.length}>
      <scrollbox ref={(value) => { scroll = value }} height={Math.max(2, Math.min(steps().rows.length, 20, Math.floor(dimensions().height * 0.75) - 12))}
        focused={focus() === "steps"} onKeyDown={(event) => {
          if (event.name !== "tab" && event.name !== "b") return
          event.preventDefault(); event.stopPropagation()
          if (event.name === "b") back()
          else setFocus("actions")
        }}>
        <For each={steps().rows}>{(step) => <box flexDirection="row" justifyContent="space-between" gap={1}>
          <text flexShrink={1} fg={props.api.theme.current.text}>#{step.number} {step.id}</text>
          <text flexShrink={0} fg={step.status === "rejected" ? props.api.theme.current.error : props.api.theme.current.textMuted}>
            {step.status}{step.attempt ? ` · try ${step.attempt}` : ""}
          </text>
        </box>}</For>
      </scrollbox>
      <text fg={props.api.theme.current.textMuted}>←→ steps {steps().page + 1}/{steps().count} · ↑↓ scroll</text>
    </Show>
    <text fg={props.api.theme.current.textMuted}>Checkpoint only · not Gate verification</text>
    <Actions api={props.api} focused={focus() === "actions" || !steps().rows.length} onTab={() => setFocus("steps")}
      shortcuts={{ b: back }} items={[{ name: "Back to Workflows (b)", run: back }]} />
    <text fg={props.api.theme.current.textMuted}>tab focus · enter select</text>
  </box>
}
function WorkflowList(props: ViewProps & { page?: number; selected?: string }) {
  let panel: BoxRenderable | undefined
  const [width, setWidth] = createSignal(0)
  const [page, setPage] = createSignal(props.page ?? 0)
  const view = createMemo(() => workflowView(props))
  const current = createMemo(() => workflowPage(view().rows, page()))
  createEffect(() => { if (!currentOwner(props)) props.api.ui.dialog.clear() })
  onMount(() => {
    props.api.ui.dialog.setSize("large")
    setWidth(panel?.width ?? 0)
    onCleanup(registerTaskListPaging(props.api, panel, { page: () => current().page, total: () => view().rows.length, setPage }))
  })
  return <box ref={(value) => { panel = value }} onSizeChange={() => setWidth(panel?.width ?? 0)}>
    <Show when={current().rows.length} fallback={<box padding={2} gap={1}>
      <text fg={props.api.theme.current.text}><b>Workflows · Beta</b></text>
      <text fg={view().available && !view().invalid ? props.api.theme.current.textMuted : props.api.theme.current.error}>
        {view().available && !view().invalid ? "No checkpoints" : "Checkpoints unavailable"}
      </text>
      <text fg={props.api.theme.current.textMuted}>esc close</text>
    </box>}>
      <props.api.ui.DialogSelect flat current={props.selected} title={`Workflows · Beta · ${current().page + 1}/${current().count}`} options={current().rows.map((row) => ({
        ...workflowListItem({ row, columns: width() - 12, measure: stringWidth }), value: row.id,
        onSelect: () => openWorkflow(props, row.id, current().page),
      }))} />
      <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={props.api.theme.current.textMuted}>←→ page · ↑↓ select · enter details · esc close</text>
      </box>
    </Show>
    <Show when={view().invalid && current().rows.length}><box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={props.api.theme.current.error}>Some checkpoints unavailable</text>
    </box></Show>
  </box>
}
function openWorkflows(props: ViewProps, page = 0, selected?: string) {
  if (!currentOwner(props) || !props.workflowEnabled) return
  const { api, session_id, workflowEnabled } = props
  api.ui.dialog.replace(() => <WorkflowList api={api} session_id={session_id} workflowEnabled={workflowEnabled} page={page} selected={selected} />)
}
function openWorkflow(props: ViewProps, runID: string, listPage?: number) {
  if (!currentOwner(props) || !props.workflowEnabled) return
  const page = listPage ?? Math.max(0, Math.floor(workflowView(props).rows.findIndex((row) => row.id === runID) / 20))
  const { api, session_id, workflowEnabled } = props
  api.ui.dialog.replace(() => <WorkflowDetails api={api} session_id={session_id} workflowEnabled={workflowEnabled} runID={runID} listPage={page} />)
}

function Overview(props: ViewProps) {
  const theme = () => props.api.theme.current
  const view = createMemo(() => projectTaskOverview({
    sessionID: props.session_id,
    getSession: (id: string) => props.api.state.session.get(id),
    hideTerminal: true,
  }))
  const groups = createMemo(() => view().groups.filter((group) => group.allTotal || group.invalid))
  const workflows = createMemo(() => workflowSidebar(workflowView(props)))
  return <box gap={1}><Show when={groups().length}>
    <box gap={1}>
      <For each={groups()}>{(group) => <box border={["left"]} backgroundColor={theme().backgroundPanel} paddingLeft={1} paddingRight={1}
        borderColor={group.invalid || group.rows.some((row) => errorStatus(row.status)) ? theme().error : theme().borderSubtle}>
        <text fg={theme().primary} onMouseUp={() => openTasks(props, group.kind)}><b>{group.kind === "command" ? "Bash" : "Subagents"}({group.total})</b></text>
        <For each={group.rows}>{(row) => <text fg={errorStatus(row.status) ? theme().error : theme().text}
          onMouseUp={() => props.api.ui.dialog.replace(() => group.kind === "command" ? <BashOutput {...props} taskID={row.id} kind={group.kind} /> : <TaskDetails {...props} taskID={row.id} kind={group.kind} />)}>
          #{row.sequence || "?"} · {row.status}{row.source === "unavailable" ? " · unavailable" : ""}
        </text>}</For>
        <Show when={group.invalid > 0}><text fg={theme().error}>Some records unavailable</text></Show>
        <text fg={theme().primary} onMouseUp={() => openTasks(props, group.kind)}>View all · ({group.allTotal})</text>
      </box>}</For>
    </box>
  </Show>
    <Show when={workflows().allTotal || workflows().invalid}>
      <box border={["left"]} backgroundColor={theme().backgroundPanel} paddingLeft={1} paddingRight={1}
        borderColor={workflows().invalid || workflows().rows.some((row) => errorStatus(row.status)) ? theme().error : theme().borderSubtle}>
        <text fg={theme().primary} onMouseUp={() => openWorkflows(props)}><b>Workflows({workflows().total}) · Beta</b></text>
        <For each={workflows().rows}>{(row) => <text fg={errorStatus(row.status) ? theme().error : theme().text}
          onMouseUp={() => openWorkflow(props, row.id)}>
          #{row.reference} · {row.status}{row.source === "unavailable" ? " · unavailable" : ""}
        </text>}</For>
        <text fg={theme().primary} onMouseUp={() => openWorkflows(props)}>View all · ({workflows().allTotal})</text>
        <Show when={workflows().invalid}><text fg={theme().error}>Some checkpoints unavailable</text></Show>
      </box>
    </Show>
  </box>
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-for-everything.tasks",
  tui: async (api, options) => {
    const selectedOptions = runtimeWorkflowOptions(options, process.env, undefined, api.state.path.directory)
    const enabled = workflowEnabled(selectedOptions)
    registerTaskOverview(api, (sessionID: string) => <Overview api={api} session_id={sessionID} workflowEnabled={enabled} />)
    registerTuiOverviewCommands(api, (kind: string, sessionID: string) => {
      const props = { api, session_id: sessionID, workflowEnabled: enabled }
      if (kind === "workflows") return openWorkflows(props)
      openTasks(props, kind)
    }, selectedOptions)
  },
}
export default plugin
