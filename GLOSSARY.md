# Codespace

A personal, single-user app for running coding work, and the Claude Code agent that does it, in cloud sandboxes instead of on the local machine.

## Language

**Workspace**:
A persistent personal dev environment holding zero or more repos, where the user and the agent do coding work. Each workspace lives in exactly one sandbox.
_Avoid_: Codespace (that is the app's name), project, environment

**Repo**:
A git repository cloned into a workspace. A workspace can gain or lose repos at any time.

**Thread**:
One conversation with the agent inside a workspace. By default it covers the whole workspace, and it can be pinned to a single repo.
_Avoid_: Chat, session, conversation

**Catalog**:
Every piece of Claude configuration available to the user, such as MCP servers, plugins, skills, agents, workflows, hooks and instruction snippets.

**Loadout**:
The selection of catalog items active in a workspace. A loadout can be saved as a named preset and reused across workspaces.
_Avoid_: Profile, config, setup

**Sandbox**:
The Modal sandbox that hosts one workspace while it runs. A stopped workspace has no sandbox, only a filesystem snapshot. It is an infrastructure term and never names the user-facing concept.
_Avoid_: VM, container, box

**Activity**:
A signal that someone is working in a workspace: either the user interacting with it, or the agent working on a turn. Processes that merely keep running (dev servers, watchers) are not activity.
_Avoid_: Usage, load

**Idle**:
The state of a workspace that has had no activity for longer than its idle timeout.
