import { describe, expect, it } from 'vitest'
import { businessName, healthLabel, initials, ringOffset } from './name'

describe('businessName', () => {
  it('drops our team tag after the business name', () => {
    expect(businessName('Horizon Marketing <> VA', 'HM deal')).toBe('Horizon Marketing')
    expect(businessName('Horizon Marketing<>Virtual Accounting', 'x')).toBe('Horizon Marketing')
    expect(businessName('Horizon Marketing <> AI Accountant', 'x')).toBe('Horizon Marketing')
    expect(businessName('Horizon Marketing | VA Team', 'x')).toBe('Horizon Marketing')
    expect(businessName('Horizon Marketing x VA', 'x')).toBe('Horizon Marketing')
  })

  it('drops our team tag before the business name', () => {
    expect(businessName('AI Accountant <> Horizon Marketing', 'x')).toBe('Horizon Marketing')
    expect(businessName('VA <> Horizon', 'x')).toBe('Horizon')
  })

  it('leaves names that only look similar', () => {
    expect(businessName('Box VA', 'x')).toBe('Box VA')
    expect(businessName('Nova Traders', 'x')).toBe('Nova Traders')
    expect(businessName('Vasant & Co', 'x')).toBe('Vasant & Co')
  })

  it('falls back to the client name', () => {
    expect(businessName(null, 'Horizon Deal')).toBe('Horizon Deal')
    expect(businessName('  ', 'Horizon Deal')).toBe('Horizon Deal')
    expect(businessName('<> VA', 'Horizon Deal')).toBe('Horizon Deal')
  })
})

describe('initials', () => {
  it('takes two words or two letters', () => {
    expect(initials('Horizon Marketing')).toBe('HM')
    expect(initials('horizon')).toBe('HO')
    expect(initials('(R.K.) Traders')).toBe('RK')
    expect(initials('  ')).toBe('?')
  })
})

describe('health ring', () => {
  it('labels by band and fills by score', () => {
    expect([healthLabel(91), healthLabel(60), healthLabel(20), healthLabel(null)]).toEqual(['Healthy', 'Watch', 'At risk', 'Not scored'])
    expect([ringOffset(100), ringOffset(0), ringOffset(null), ringOffset(150), ringOffset(91)]).toEqual([0, 264, 264, 0, 24])
  })
})
