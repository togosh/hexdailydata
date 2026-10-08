# Starter validation — actual scope

The planner ran21 dependency-free starter-tool tests on Linux with Node22.16.0 and
Git2.47.3. Final result:21passed,0failed,0skipped. They exercise real temporary Git
initialization, repeat preservation, paths with spaces, nested/wrong/symlink/modified
workspace refusal, polluted Git environment isolation, committed source ZIP creation,
dirty/secret-path refusal and explicit not-implemented application commands.

Final archive CRC, exact member bytes/digests, JSON syntax, local references and the
protected input ZIP identity were also checked. The generated source-package smoke was
opened as a ZIP and verified to contain only the committed files, with no runtime state.
Tools were executed only on synthetic temporary copies, not an owner repository.

These are STARTER checks, not application qualification. No authentication library was
installed by this planner, and no application/SQL/Docker/SMTP/browser/payment test ran.
Windows PowerShell/Git/fs/junction handling and target Node24 application runtime were
NOT_RUN here. Codex must implement and execute the actual lab checks. The setup's
filesystem/Git guards do not sandbox Codex; runtime isolation remains a task deliverable.

The old lab ZIP's claimed77tests are not reused. That exact old ZIP was unavailable.
The first preparation test launch preceded creation of tests/ and could not find its
file; after creating it, the actual21-test suite passed. No failed app result is hidden.

STARTER_FILES.json is an initial extraction/setup boundary only. Do not turn it into
a runtime gate, a per-request hash, or a reason to reject normal later source edits.
After implementation, maintain application tests separately; these initial-tool fixtures
are not the definition of application success. Update/remove obsolete starter commands
in the lab README and package scripts deliberately, not by claiming stubs are passed.
