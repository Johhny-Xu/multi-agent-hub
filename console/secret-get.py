#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Secret Service 读取助手：按 service + username 前缀取回令牌（供 vendor-quota.mjs 调用）。

用法: python3 secret-get.py <service> <username-prefix>
输出: 命中的 secret 明文（仅 stdout）；未命中输出空并退出码 3。
无头环境依赖 keyring 已解锁（keyring-unlock.py 负责）。
"""
import sys
import dbus


def main():
    if len(sys.argv) < 3:
        print("usage: secret-get.py <service> <username-prefix>", file=sys.stderr)
        return 2
    want_service, want_user = sys.argv[1], sys.argv[2]

    bus = dbus.SessionBus()
    svc = bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets")
    service = dbus.Interface(svc, "org.freedesktop.Secret.Service")
    coll_path = str(service.ReadAlias("default"))
    if coll_path == "/":
        print("no default keyring", file=sys.stderr)
        return 3
    coll = bus.get_object("org.freedesktop.secrets", coll_path)
    items = dbus.Interface(coll, "org.freedesktop.DBus.Properties").Get(
        "org.freedesktop.Secret.Collection", "Items")

    def read_attrs(item_path):
        obj = bus.get_object("org.freedesktop.secrets", item_path)
        props = dbus.Interface(obj, "org.freedesktop.DBus.Properties")
        return dict(props.Get("org.freedesktop.Secret.Item", "Attributes"))

    hits = []
    for it in items:
        try:
            attrs = read_attrs(it)
        except Exception:
            continue
        if str(attrs.get("service", "")) == want_service and \
                str(attrs.get("username", "")).startswith(want_user):
            hits.append(it)

    if not hits:
        return 3

    # 可能存在多个条目（含轮换残留），取第一个；如被锁定先尝试 Unlock
    locked = service.Unlock(hits)
    sess_path = service.OpenSession("plain", dbus.String("", variant_level=1))[1]
    obj = bus.get_object("org.freedesktop.secrets", hits[0])
    secret = dbus.Interface(obj, "org.freedesktop.Secret.Item").GetSecret(sess_path)
    sys.stdout.write(bytes(bytearray(secret[2])).decode("utf-8", "replace").strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
