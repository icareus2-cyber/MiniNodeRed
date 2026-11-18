"""Microflow accounts: a small window to add users and set passwords.

Run it on the server PC (double-click tools/user-manager.bat, or `python tools/user_manager.py`).
It does not touch the database itself: every change goes through tools/user.js (the same
code as `npm run user`), so passwords are hashed exactly as the server expects. The new
password is handed over in an environment variable, never on the command line.
Uses the same database as the server: DB_PATH if set, else data/microflow.sqlite.
"""

import json
import os
import shutil
import subprocess
import sys
import tkinter as tk
from tkinter import messagebox, ttk

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USER_JS = os.path.join(ROOT, "tools", "user.js")
NODE = shutil.which("node")
MIN_PASSWORD = 8
NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0  # no console flash on Windows


def run_tool(*args, password=None):
    """Runs tools/user.js; returns its output or raises RuntimeError with its message."""
    env = dict(os.environ)
    env.pop("MICROFLOW_PASSWORD", None)
    if password is not None:
        env["MICROFLOW_PASSWORD"] = password
    done = subprocess.run(
        [NODE, USER_JS, *args],
        cwd=ROOT,
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        creationflags=NO_WINDOW,
    )
    if done.returncode != 0:
        lines = (done.stderr or done.stdout).strip().splitlines()
        raise RuntimeError(lines[-1].removeprefix("Error: ") if lines else "The account tool failed.")
    return done.stdout.strip()


def when(iso):
    """The database's UTC time as this PC's local time."""
    if not iso:
        return "never"
    try:
        from datetime import datetime

        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return iso[:16]


class PasswordDialog(tk.Toplevel):
    """Asks for a user name (new users only), a password twice and the admin box."""

    def __init__(self, parent, title, name=None):
        super().__init__(parent)
        self.title(title)
        self.resizable(False, False)
        self.transient(parent)
        self.result = None
        box = ttk.Frame(self, padding=16)
        box.grid(sticky="nsew")

        self.name = tk.StringVar(value=name or "")
        self.pw1 = tk.StringVar()
        self.pw2 = tk.StringVar()
        self.admin = tk.BooleanVar()
        self.show = tk.BooleanVar()

        row = 0
        ttk.Label(box, text="User name (ID)").grid(row=row, column=0, sticky="w", pady=4)
        name_entry = ttk.Entry(box, textvariable=self.name, width=28)
        name_entry.grid(row=row, column=1, pady=4)
        if name:
            name_entry.state(["readonly"])
        row += 1
        ttk.Label(box, text="Password").grid(row=row, column=0, sticky="w", pady=4)
        self.e1 = ttk.Entry(box, textvariable=self.pw1, width=28, show="•")
        self.e1.grid(row=row, column=1, pady=4)
        row += 1
        ttk.Label(box, text="Password again").grid(row=row, column=0, sticky="w", pady=4)
        self.e2 = ttk.Entry(box, textvariable=self.pw2, width=28, show="•")
        self.e2.grid(row=row, column=1, pady=4)
        row += 1
        ttk.Checkbutton(box, text="Show password", variable=self.show, command=self.toggle).grid(
            row=row, column=1, sticky="w"
        )
        row += 1
        if not name:
            ttk.Checkbutton(box, text="Admin (can manage users)", variable=self.admin).grid(
                row=row, column=1, sticky="w", pady=(4, 0)
            )
            row += 1
        ttk.Label(box, text=f"At least {MIN_PASSWORD} characters.", foreground="#666").grid(
            row=row, column=1, sticky="w", pady=(6, 0)
        )
        row += 1
        buttons = ttk.Frame(box)
        buttons.grid(row=row, column=0, columnspan=2, sticky="e", pady=(14, 0))
        ttk.Button(buttons, text="Cancel", command=self.destroy).pack(side="right")
        ttk.Button(buttons, text="OK", command=self.ok).pack(side="right", padx=(0, 8))

        self.bind("<Return>", lambda e: self.ok())
        self.bind("<Escape>", lambda e: self.destroy())
        (self.e1 if name else name_entry).focus_set()
        self.grab_set()
        self.wait_window()

    def toggle(self):
        mark = "" if self.show.get() else "•"
        self.e1.config(show=mark)
        self.e2.config(show=mark)

    def ok(self):
        name, pw1, pw2 = self.name.get().strip(), self.pw1.get(), self.pw2.get()
        if not name:
            return messagebox.showwarning("Missing", "Type a user name.", parent=self)
        if len(pw1) < MIN_PASSWORD:
            return messagebox.showwarning(
                "Too short", f"The password needs at least {MIN_PASSWORD} characters.", parent=self
            )
        if pw1 != pw2:
            return messagebox.showwarning("Different", "The two passwords differ.", parent=self)
        self.result = (name, pw1, self.admin.get())
        self.destroy()


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Microflow · Users")
        self.geometry("640x380")
        self.minsize(560, 300)

        top = ttk.Frame(self, padding=(12, 10, 12, 0))
        top.pack(fill="x")
        ttk.Label(top, text="Microflow accounts", font=("Segoe UI", 13, "bold")).pack(side="left")
        ttk.Button(top, text="↻ Refresh", command=self.load).pack(side="right")

        cols = ("name", "role", "state", "flows", "last")
        self.table = ttk.Treeview(self, columns=cols, show="headings", selectmode="browse")
        for col, text, width in (
            ("name", "User name (ID)", 170),
            ("role", "Role", 70),
            ("state", "State", 80),
            ("flows", "Flows", 60),
            ("last", "Last login", 140),
        ):
            self.table.heading(col, text=text)
            self.table.column(col, width=width, anchor="w")
        self.table.pack(fill="both", expand=True, padx=12, pady=10)
        self.table.bind("<<TreeviewSelect>>", lambda e: self.update_buttons())
        self.table.bind("<Double-1>", lambda e: self.set_password())

        bar = ttk.Frame(self, padding=(12, 0, 12, 6))
        bar.pack(fill="x")
        ttk.Button(bar, text="＋ Add user", command=self.add).pack(side="left")
        self.b_pw = ttk.Button(bar, text="Set password", command=self.set_password)
        self.b_admin = ttk.Button(bar, text="Make admin", command=self.toggle_admin)
        self.b_off = ttk.Button(bar, text="Disable", command=self.toggle_disabled)
        self.b_del = ttk.Button(bar, text="Delete", command=self.delete)
        for b in (self.b_pw, self.b_admin, self.b_off, self.b_del):
            b.pack(side="left", padx=(8, 0))

        self.status = tk.StringVar()
        ttk.Label(self, textvariable=self.status, foreground="#555", padding=(12, 0, 12, 10)).pack(
            fill="x"
        )
        self.users = {}
        self.load()

    # ── helpers ──
    def selected(self):
        sel = self.table.selection()
        return self.users.get(sel[0]) if sel else None

    def update_buttons(self):
        u = self.selected()
        for b in (self.b_pw, self.b_admin, self.b_off, self.b_del):
            b.state(["!disabled"] if u else ["disabled"])
        if u:
            self.b_admin.config(text="Remove admin" if u["admin"] else "Make admin")
            self.b_off.config(text="Enable" if u["disabled"] else "Disable")

    def act(self, done_text, *args, password=None):
        try:
            run_tool(*args, password=password)
        except Exception as e:  # noqa: BLE001 (shown to the user)
            messagebox.showerror("Not done", str(e), parent=self)
            return False
        self.load()
        self.status.set(done_text)
        return True

    def load(self):
        keep = self.selected()
        try:
            users = json.loads(run_tool("list", "--json") or "[]")
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("Cannot read the accounts", str(e), parent=self)
            users = []
        self.table.delete(*self.table.get_children())
        self.users = {}
        for u in users:
            iid = str(u["id"])
            self.users[iid] = u
            self.table.insert(
                "",
                "end",
                iid=iid,
                values=(
                    u["name"],
                    "admin" if u["admin"] else "user",
                    "disabled" if u["disabled"] else "active",
                    u.get("flows", 0),
                    when(u.get("last_login")),
                ),
            )
        if keep and str(keep["id"]) in self.users:
            self.table.selection_set(str(keep["id"]))
        self.status.set(f"{len(users)} account{'s' if len(users) != 1 else ''}. Double-click a user to set a new password.")
        self.update_buttons()

    # ── actions ──
    def add(self):
        d = PasswordDialog(self, "Add user")
        if d.result:
            name, pw, admin = d.result
            args = ["add", name] + (["--admin"] if admin else [])
            self.act(f"Created {name}. They can log in now.", *args, password=pw)

    def set_password(self):
        u = self.selected()
        if not u:
            return
        d = PasswordDialog(self, f"New password for {u['name']}", name=u["name"])
        if d.result:
            self.act(
                f"New password set for {u['name']} (logged out everywhere).",
                "passwd",
                u["name"],
                password=d.result[1],
            )

    def toggle_admin(self):
        u = self.selected()
        if u:
            on = "off" if u["admin"] else "on"
            self.act(f"{u['name']}: admin {on}.", "admin", u["name"], on)

    def toggle_disabled(self):
        u = self.selected()
        if u:
            cmd = "enable" if u["disabled"] else "disable"
            self.act(f"{u['name']}: {cmd}d.", cmd, u["name"])

    def delete(self):
        u = self.selected()
        if not u:
            return
        flows = u.get("flows", 0)
        if messagebox.askyesno(
            "Delete user",
            f"Delete {u['name']} and their {flows} flow{'s' if flows != 1 else ''}?\nThis cannot be undone.",
            icon="warning",
            parent=self,
        ):
            self.act(f"{u['name']} deleted.", "delete", u["name"])


def main():
    if not NODE:
        tk.Tk().withdraw()
        messagebox.showerror("Node.js not found", "Microflow's account tool needs Node.js (node) on PATH.")
        return
    App().mainloop()


if __name__ == "__main__":
    main()
