# grogan.codes

A personal, single-user app for running coding work, and the Claude Code agent that does it, on EC2 instances in the user's AWS account instead of on the local machine.

## Language

**Workspace**:
A persistent personal dev environment holding zero or more repos, where the user and the agent do coding work. Each workspace lives on exactly one instance.
_Avoid_: grogan.codes (that is the app's name), Codespace (its old name), project, environment

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

**Instance**:
The EC2 instance that hosts one workspace. Its root volume is the workspace's disk. A stopped workspace is a stopped instance whose disk persists; a hibernated one also kept its memory on that disk. It is an infrastructure term and never names the user-facing concept.
_Avoid_: Sandbox (the Modal-era term), VM, container, box

**Cold storage**:
Where a long-stopped workspace's disk goes: the app snapshots the disk and terminates the instance, so only the data written is billed. Starting a cold workspace restores it onto a new instance; files are kept, running processes are not. A cold workspace is still stopped, not deleted.
_Avoid_: Archive (except as the "Archive now" action that moves a workspace there), backup

**Market**:
How a workspace's instance is bought: **on-demand** (full price, runs until stopped) or **spot** (discounted spare capacity that AWS can reclaim with 2 minutes' notice, which stops or hibernates the instance and keeps its disk). Chosen when the workspace is created.

**Activity**:
A signal that someone is working in a workspace: either the user interacting with it, or the agent working on a turn. Processes that merely keep running (dev servers, watchers) are not activity.
_Avoid_: Usage, load

**Idle**:
The state of a workspace that has had no activity for longer than its idle timeout.
