import { describe, expect, it } from 'vitest'
import { resolveMentions } from './mentions'

const members = [
  { user_id: 'a', full_name: 'Ana López', email: 'ana@x.com' },
  { user_id: 'b', full_name: 'Ana', email: 'ana2@x.com' },
  { user_id: 'c', full_name: null, email: 'carlos@x.com' },
]

describe('resolveMentions', () => {
  it('matches full names and email handles, case-insensitive', () => {
    expect(resolveMentions('@ana lópez y @Carlos revisen', members)).toEqual(['a', 'c'])
  })
  it('a longer name does not also mention its prefix', () => {
    expect(resolveMentions('hola @Ana López', members)).toEqual(['a'])
    expect(resolveMentions('hola @Ana, ¿puedes?', members)).toEqual(['b'])
  })
  it('no @ means no mention', () => {
    expect(resolveMentions('Ana López revisa', members)).toEqual([])
  })
})
