'use strict';
// Users: list, create, edit, suspend, delete. All rules (who may touch whom, the last admin) are enforced by the API.
const ROLE_INFO = {
  admin: 'Everything, including admin accounts.',
  editor: 'Everything except creating or changing admin accounts.',
  analyst: 'Stats only: sales report, stock and the overview. No recipes, costs, ingredients or purchases.',
  clerk: 'Registers sales in the calculator, and can change or delete their own sales for 24 hours.',
};
const roleLabel = r => r ? r[0].toUpperCase() + r.slice(1) : '—';

async function usersPage(id) {
  const data = await api('/saulaya/users');
  if (id) return userForm(data, id);
  const rows = data.users.map(u => ({ id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' '), email: u.email,
    role: roleLabel(u.role), status: u.status, last_access: u.last_access }));
  return [h('div', { class: 'bar' }, h('h2', { style: 'margin:0' }, 'Users'), h('span', { class: 'sp' }),
    h('button', { class: 'primary', onclick: () => { location.hash = '#/users/new'; } }, '+ New user')),
  h('div', { class: 'roles' }, data.assignable.map(r => h('div', { class: 'stat' }, h('span', {}, roleLabel(r)), h('small', {}, ROLE_INFO[r])))),
  h('div', { style: 'margin-top:14px' }, table(rows, r => `#/users/${r.id}`, { hide: ['id'] }))];
}

function userForm(data, id) {
  const isNew = id === 'new', u = isNew ? { status: 'active', role: data.assignable.includes('clerk') ? 'clerk' : data.assignable[0] } : data.users.find(x => x.id === id);
  if (!u) return [h('p', { class: 'note err' }, 'User not found, or you may not change them.')];
  const mk = (type, value, extra = {}) => h('input', { type, value: value ?? '', ...extra });
  const first = mk('text', u.first_name), last = mk('text', u.last_name), email = mk('email', u.email, { required: true, autocomplete: 'off' });
  const password = mk('password', '', { autocomplete: 'new-password', minlength: 10, required: isNew, placeholder: isNew ? '' : 'leave blank to keep it' });
  const role = h('select', {}, data.assignable.map(r => h('option', { value: r, selected: r === u.role }, roleLabel(r))));
  const status = h('select', {}, ['active', 'suspended'].map(s => h('option', { value: s, selected: s === u.status }, s)));
  const info = h('small', {}), showInfo = () => { info.textContent = ROLE_INFO[role.value]; };
  role.addEventListener('change', showInfo); showInfo();
  const self = id === data.me;
  if (self) { role.disabled = status.disabled = true; } // you cannot lock yourself out from here

  const done = text => { location.hash = '#/users'; note(text); };
  const save = async ev => {
    ev.preventDefault();
    try {
      if (isNew) await api('/saulaya/users', { method: 'POST', body: { first_name: first.value, last_name: last.value, email: email.value, password: password.value, role: role.value } });
      else await api(`/saulaya/users/${id}`, { method: 'PATCH', body: { first_name: first.value, last_name: last.value, email: email.value,
        ...(password.value ? { password: password.value } : {}), ...(self ? {} : { role: role.value, status: status.value }) } });
      done(isNew ? 'User created' : 'Saved');
    } catch (e) { note(e.message, true); }
  };
  const remove = async () => {
    if (!confirm(`Delete ${email.value}? They lose access at once. Their sales stay.`)) return;
    try { await api(`/saulaya/users/${id}`, { method: 'DELETE' }); done('Deleted'); } catch (e) { note(e.message, true); }
  };
  return [h('div', { class: 'bar head' }, h('h2', {}, h('a', { class: 'crumb', href: '#/users' }, 'Users'), ' › ', isNew ? 'New' : u.email)),
    h('form', { class: 'card', onsubmit: save },
      h('div', { class: 'grid' }, fieldRow({ l: 'first name' }, first), fieldRow({ l: 'last name' }, last), fieldRow({ l: 'email' }, email),
        fieldRow({ l: isNew ? 'password' : 'new password', hint: 'at least 10 characters' }, password)),
      h('div', { class: 'grid', style: 'margin-top:12px' }, h('label', { class: 'f' }, h('span', {}, 'role'), role, info), isNew ? '' : fieldRow({ l: 'status', hint: 'suspended = cannot log in' }, status)),
      self ? h('p', { class: 'hint' }, 'This is you: you cannot change your own role or status, or delete yourself.') : '',
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Save'),
        h('button', { type: 'button', onclick: () => { location.hash = '#/users'; } }, 'Cancel'), h('span', { class: 'sp' }),
        isNew || self ? '' : h('button', { type: 'button', class: 'danger', onclick: remove }, 'Delete')))];
}
