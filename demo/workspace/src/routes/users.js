const users = [
  { id: 1, name: 'Alice', role: 'admin' },
  { id: 2, name: 'Bob', role: 'member' },
]

export const listUsers = () => users
export const findUser = id => users.find(u => u.id === id)
