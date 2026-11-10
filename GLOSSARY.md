# DCABSM

DocCyblade's Actual Budget Server Manager: a tool for running and maintaining multiple Actual Budget servers on one host.

## Language

**Release**:
One installed version of Actual on disk. It is shared between Instances and never changed after install.
_Avoid_: Version (when meaning the installed copy), app folder, build

**Node runtime**:
One installed version of Node that DCABSM manages. Each Release is tied to one Node runtime when it is installed, and several Releases can share it.
_Avoid_: System Node, Host Node

**Instance**:
One running Actual server with its own data, config, port, hostname and service. It points at exactly one Release.
_Avoid_: Site, server, budget, deployment

**Instance name**:
The short, fixed identifier an Instance is known by. It is separate from the Instance's hostname and never changes after creation.
_Avoid_: Instance ID, hostname, slug

**Instance account**:
The operating system account that one Instance runs as. Every Instance has its own, and it exists only as long as the Instance does.
_Avoid_: Service user, Actual user

**Instance record**:
DCABSM's own stored facts about one Instance. Actual's config for that Instance is generated from it.
_Avoid_: Instance config, config

**Instance setting**:
One of Actual's server settings that the System Admin chose for one Instance. It is kept in the Instance record, and anything not set keeps the Release's own default.
_Avoid_: Option, config key

**Instance certificate**:
The TLS certificate and private key that one Instance serves. Every Instance always has its own copy, even when several Instances use the same wildcard certificate.
_Avoid_: Shared certificate

**Host**:
The single Debian-based virtual or physical machine that DCABSM is installed on and manages. Containers are not supported.
_Avoid_: Server (ambiguous with an Actual server), node, box

**Manual System Admin task**:
A job the System Admin must do by hand, because DCABSM deliberately leaves it to them, such as fixing their own Nginx config or opening the firewall.
_Avoid_: Manual step, user action, TODO

**Unsupported Host**:
A Host where a DCABSM safety check has ever been overridden. It stays unsupported for good, even after the override is gone.
_Avoid_: Tainted, forced

**System Admin**:
The person who runs DCABSM commands on the Host. Every DCABSM command needs root, so they always have admin rights on the Host.
_Avoid_: Admin on its own (Actual has its own admin role for people who log in), operator, user

**Budget file**:
One budget held by an Instance, using Actual's own term. An Instance can hold several.
_Avoid_: Budget (when meaning the file), database

**Upgrade**:
Moving an Instance to a newer Release, protected by a pre-upgrade backup.
_Avoid_: Update (when meaning an Instance), migrate

**Rollback**:
Returning an Instance to the Release it was on before its latest Upgrade. It keeps current data unless that Release can't run on it.
_Avoid_: Downgrade, revert

**Self-update**:
Moving DCABSM itself to another version. It never changes an Instance's Release.
_Avoid_: Upgrade (that is for Instances), update

**Layout**:
The version number of how DCABSM stores its state on the Host, kept in `dcabsm.json`. Each DCABSM version expects one Layout, and a Self-update migrates the Host forward to it.
_Avoid_: Schema, format version

**Owned file**:
A file DCABSM writes on the Host outside an Instance, such as the systemd unit or the Nightly run timer. It is rewritten only while it still matches what DCABSM last wrote, so a file the System Admin edited is kept.
_Avoid_: Managed file, config file

**TurnKey**:
TurnKey Linux, a family of appliance images on Debian. Only TurnKey Core and TurnKey Node.js are supported Hosts, and setup disables the pieces of them that clash with DCABSM.
_Avoid_: Appliance (on its own), TKL

**Backup**:
One archive of a whole Instance at one moment, taken while it is stopped. Each records its kind, such as manual, scheduled, pre-upgrade, pre-restore, pre-clone or final.
_Avoid_: Snapshot, export (Actual's export is one Budget file)

**Restore**:
Returning an Instance's data to what a Backup holds, on the Release the Backup records. Every device must then resync from the server.
_Avoid_: Rollback (that changes Release), recover

**Regroup**:
Giving every Budget file on an Instance a new sync identity after a Restore, so devices can't silently push back changes the Restore removed.
_Avoid_: Sync reset (that is Actual's own action from a device)

**Clone**:
A new Instance made from a Backup of another, with its own name, account, port, hostname and certificate. Everything inside Actual, including logins, is copied.
_Avoid_: Copy, duplicate (Actual's duplicate is one Budget file)

**Pre-upgrade backup**:
The backup taken while an Instance is stopped for an Upgrade. It records the Release the Instance was leaving.
_Avoid_: Snapshot

**Nightly run**:
The once-a-day unattended DCABSM job that takes each Instance's scheduled Backup in turn and then applies Retention.
_Avoid_: Cron job, backup job

**Retention**:
The rules for which of an Instance's Backups are kept, counted per kind.
_Avoid_: Rotation, cleanup
