// Attack lists shared by more than one test file.

/**
 * Every way to change a parent table: its rows and its structure. Each must be refused with 42501
 * for every restaurant role, in a transaction that is otherwise allowed to write.
 */
export const PARENT_ATTACKS: [string, (t: string) => string][] = [
  ["insert", (t) => `insert into ${t} select * from ${t} limit 1`],
  ["update", (t) => `update ${t} set id = id`],
  ["delete", (t) => `delete from ${t}`],
  ["truncate", (t) => `truncate ${t}`],
  ["add a column", (t) => `alter table ${t} add column x_sec_probe int`],
  ["drop a column", (t) => `alter table ${t} drop column updated_at`],
  ["drop the table", (t) => `drop table ${t}`],
  ["rename the table", (t) => `alter table ${t} rename to x_sec_probe`],
  ["take ownership", (t) => `alter table ${t} owner to current_user`],
  ["add an index", (t) => `create index x_sec_probe on ${t} (id)`],
  ["add a trigger", (t) => `create trigger x_sec_probe before insert on ${t} for each row execute function rms.touch_updated_at()`],
  ["add a rule", (t) => `create rule x_sec_probe as on insert to ${t} do instead nothing`],
  ["add a policy", (t) => `create policy x_sec_probe on ${t} using (true)`],
  ["switch row security", (t) => `alter table ${t} enable row level security`],
  ["comment on it", (t) => `comment on table ${t} is 'x'`],
  ["lock it against everyone", (t) => `lock table ${t} in access exclusive mode`],
];
