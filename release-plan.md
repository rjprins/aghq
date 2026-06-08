minimum release checklist for agmux:

---

Core must work flawlessly

* PTYs survive refresh without garbling
* PTYs reconnect automatically after refresh
* Input always works
* Output never freezes or disappears
* Scrollback works
* Scroll to bottom works reliably

If sessions feel fragile, people will bounce immediately.

---

Session visibility and control

* List sessions in side panel
* Switch between sessions instantly
* Clear session titles (directory + title)
* Show basic status (running vs waiting for input)

No fancy layouts needed yet. Single view is fine.

---

Launch experience

* Quick launch button
* Can launch agent in selected directory
* Optional args field
* New session appears immediately and reliably

This is critical. Launch friction kills adoption.

---

Projects (minimum viable)

* Group sessions by directory
* Allow pinning directories
* Remember pinned projects

No advanced project settings needed yet.

---

Persistence

* Sessions restore after refresh
* Projects remain pinned after refresh
* UI state doesn’t reset constantly

Stateless tools feel like toys.

---

Documentation
README with only this:

* what agmux is (one sentence)
* screenshot
* install instructions (very simple)
* how to launch agent
* how to reconnect sessions

