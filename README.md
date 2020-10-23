<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2020 Joyent, Inc.
-->

# triton-vminfod

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md) --

# Notes

This is the linux port of vminfod.

# About

At its core, `vminfod` is a daemon that provides read-only access to "VMs"
(zones, HVM, LX zones, etc.) on a given system over an HTTP interface available
to the global zone of a system on `127.0.0.1:9090`.  It is a cache for this
information, only reaching out to the system to gather new information when
modifications are made to the system/to a zone.

On a system with `vminfod`, read-only actions like `vmadm list`, `vmadm lookup`,
and `vmadm get` are thin wrappers around HTTP requests to the `vminfod` daemon.
Read-write actions such as `vmadm create`, `vmadm reboot`, `vmadm update`, etc.
by contrast, behave in their normal way by reaching out to the system
directly to make the changes requested (e.g.  `vmadm update <vm_uuid> quota=10`
does some checks and calls `zfs set quota=10g` on the zoneroot dataset).  In
addition to making the change however, these read-write actions now "block"
on `vminfod`, and wait for the changes to be reflected before returning to the
caller.

On top of this static interface for looking up VM information in `vminfod`,
there is a second streaming interface that can be used that emits an event
anytime an update is done on the system (whether the source of the change was
`vmadm` or not).  This works by long-polling the `/events` endpoint, which sends
newline-separate JSON objects each time a change is made to the system; for
example, when a VM is created, deleted, or one of its properties is modified.

# Usage

Node clients can use the vminfod client node library to easily communicate
with the vminfod server.

The sbin/vminfo.js script can be used to interact with the vminfod server to
ensure it's running or to get debugging information.

# References

* [Design Document](https://github.com/joyent/rfd/blob/master/rfd/0039/README.md)
* [Troubleshooting](docs/troubleshooting.md)
