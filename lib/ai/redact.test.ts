import { describe, expect, it } from 'vitest'
import { sanitiseBody } from '@/lib/council/prompt'
import { hasCredential, HIDDEN, maskCredentials } from './redact'

describe('maskCredentials', () => {
  it('hides the value after a credential word', () => {
    expect(maskCredentials('GST portal OTP is 445566, please file')).toBe(`GST portal OTP is ${HIDDEN}, please file`)
    expect(maskCredentials('password Alpha@2026')).toBe(`password ${HIDDEN}`)
    expect(maskCredentials('Login id: rahul123 password: Pass@1x')).toBe(`Login id: ${HIDDEN} password: ${HIDDEN}`)
    expect(maskCredentials('pwd hai abc123.')).toBe(`pwd hai ${HIDDEN}.`)
    expect(maskCredentials('MPIN-9081')).toBe(`MPIN-${HIDDEN}`)
  })
  it('leaves ordinary sentences alone', () => {
    for (const t of [
      'OTP is required for filing',
      'GST password change kar diya, 2026 return pending, 14000 tax',
      'Please share the PIN code',
      'password reset link sent',
      'ARN AA2910260012345 for October',
      'CPIN 26112900012345 generated',
    ]) {
      expect(maskCredentials(t)).toBe(t)
      expect(hasCredential(t)).toBe(false)
    }
  })
  it('hides long account or card numbers only in bank or card messages', () => {
    expect(maskCredentials('HDFC bank a/c 50100123456789 ifsc HDFC0001234')).toBe(`HDFC bank a/c ${HIDDEN} ifsc HDFC0001234`)
    expect(maskCredentials('Card 4111 1111 1111 1111 exp 12/29')).toBe(`Card ${HIDDEN} exp 12/29`)
    expect(maskCredentials('Invoice 123456789012 raised')).toBe('Invoice 123456789012 raised')
  })
  it('handles empty input', () => {
    expect(maskCredentials(null)).toBe('')
    expect(maskCredentials('')).toBe('')
  })
  it('sanitiseBody masks before escaping, so models never see the value', () => {
    expect(sanitiseBody('<b>OTP: 998877</b>')).toBe(`&lt;b&gt;OTP: ${HIDDEN}&lt;/b&gt;`)
  })
})
