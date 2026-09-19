import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { tasks } = JSON.parse(fs.readFileSync(path.join(root, 'config/tasks.json'), 'utf8'));
const requested = process.argv[2] ?? 'next';
const passed = new Set(tasks.filter((task) => task.status === 'passed').map((task) => task.id));

if (requested === 'next') {
  const eligible = tasks.filter(
    (task) => task.status !== 'passed' && task.dependsOn.every((id) => passed.has(id)),
  );
  console.log(
    eligible.length
      ? eligible.map((task) => `${task.id}: ${task.title}`).join('\n')
      : 'No eligible task. Check task state or all tasks are complete.',
  );
} else {
  const task = tasks.find((item) => item.id === requested);
  if (!task) {
    console.error('Use next or a task ID from 01 through 11.');
    process.exit(2);
  }
  if (task.status === 'passed') {
    console.error(`Task ${requested} is already passed. Review progress before repeating it.`);
    process.exit(2);
  }
  const missing = task.dependsOn.filter((id) => !passed.has(id));
  if (missing.length) {
    console.error(
      `Task ${requested} is not eligible; prerequisites not passed: ${missing.join(', ')}.`,
    );
    process.exit(2);
  }

  const plan = fs.readFileSync(path.join(root, 'docs/build-plan.md'), 'utf8');
  const section = plan.split(`## ${requested} — `)[1]?.split('\n## ')[0];
  if (!section) throw new Error('Task document missing.');

  console.log(
    [
      'Work only in this v2 repository. Follow AGENTS.md and .agents/skills/hdd-build/SKILL.md; read relevant contracts/tests.',
      'Run workspace preflight. Never execute or mutate the legacy sibling.',
      'Complete ONLY this task, affected tests, focused review and in-scope repairs:',
      '',
      `## ${requested} — ${section}`,
      '',
      `Record actual commands/results/limitations under ignored artifacts/task-${requested}.`,
      'Use one separate read-only reviewer with .agents/skills/hdd-review/SKILL.md after your candidate is ready.',
      'Fix supported findings, rerun affected checks, and request same-reviewer delta checks; at most two corrective rounds by default.',
      'No separate reviewer available: report review pending, never invent independence or mark the task passed.',
      'Update task state/progress only for genuinely completed and reviewed work; commit locally.',
      'Return a source-only ZIP of the committed new repository and the small report; exclude data/secrets.',
      'No push or deployment without explicit owner authorization; do not start another task.',
    ].join('\n'),
  );
}
