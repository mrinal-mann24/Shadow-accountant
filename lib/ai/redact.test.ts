import { describe, expect, it } from 'vitest'
import { sanitiseBody } from '@/lib/ai/sanitise'
import { hasCredential, HIDDEN, maskCredentials, maskTaxIds } from './redact'

describe('maskTaxIds', () => {
  it('hides PAN and GSTIN in AI-written text', () => {
    expect(maskTaxIds('The client sent PAN AZGPA6124N on 26 Nov')).toBe('The client sent PAN [PAN] on 26 Nov')
    expect(maskTaxIds('GSTIN 27AAPFU0939F1ZV filed')).toBe('GSTIN [GSTIN] filed')
  })
  it('leaves ordinary codes alone', () => {
    for (const t of ['GSTR-3B for October', 'ARN AA2910260012345', 'HDFC0001234', 'Invoice INV2026001']) expect(maskTaxIds(t)).toBe(t)
  })
})

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
  it('is safe to run twice: masked text stays as it is (no "[hidden]]")', () => {
    const once = maskCredentials('the OTP is 445566 for PTRC')
    expect(maskCredentials(once)).toBe(once)
    expect(maskCredentials(`since the OTP ${HIDDEN} to the registered number`)).toBe(`since the OTP ${HIDDEN} to the registered number`)
  })
  it('a verb after OTP is not a value ("the OTP goes to the registered number")', () => {
    expect(maskCredentials('since the OTP goes to the registered number')).toBe('since the OTP goes to the registered number')
    expect(maskCredentials('OTP comes on the owner phone')).toBe('OTP comes on the owner phone')
  })
  it('hides long account or card numbers only in bank or card messages', () => {
    expect(maskCredentials('HDFC bank a/c 50100123456789 ifsc HDFC0001234')).toBe(`HDFC bank a/c ${HIDDEN} ifsc HDFC0001234`)
    expect(maskCredentials('Card 4111 1111 1111 1111 exp 12/29')).toBe(`Card ${HIDDEN} exp 12/29`)
    expect(maskCredentials('Invoice 123456789012 raised')).toBe('Invoice 123456789012 raised')
  })
  it('covers the formats found in review', () => {
    expect(maskCredentials('Password: "Ab,c@1"')).toBe(`Password: "${HIDDEN}"`)
    expect(maskCredentials("password is 'abc@1'")).toBe(`password is '${HIDDEN}'`)
    expect(maskCredentials('password is Abc,123;x ok')).toBe(`password is ${HIDDEN} ok`)
    expect(maskCredentials('pass: hello12')).toBe(`pass: ${HIDDEN}`)
    expect(maskCredentials('pswd Rahul@9')).toBe(`pswd ${HIDDEN}`)
    expect(maskCredentials('net banking id ravi123')).toBe(`net banking id ${HIDDEN}`)
    expect(maskCredentials('customer id 88776655')).toBe(`customer id ${HIDDEN}`)
    expect(maskCredentials('pin number 1234')).toBe(`pin number ${HIDDEN}`)
    expect(maskCredentials('OTP code 1234')).toBe(`OTP code ${HIDDEN}`)
    expect(maskCredentials('login id: ram')).toBe(`login id: ${HIDDEN}`)
    expect(maskCredentials('mera password Abc@1 hai')).toBe(`mera password ${HIDDEN} hai`)
    expect(maskCredentials('पासवर्ड Abc@1')).toBe(`पासवर्ड ${HIDDEN}`)
  })
  it('keeps accounting numbers that only sit near bank or credit words', () => {
    for (const t of [
      'ITC credit challan 9876543210 paid',
      'bank 01-04-2025 30-04-2025 statement',
      'credit note 2026110012345 issued',
      'Please pass the entry for 14000',
    ]) expect(maskCredentials(t)).toBe(t)
    expect(maskCredentials('account no. 1234567890 HDFC')).toBe(`account no. ${HIDDEN} HDFC`)
  })
  it('is fast on very long input', () => {
    const started = Date.now()
    maskCredentials(`otp${' '.repeat(65_000)}x`)
    maskCredentials('password '.repeat(5_000))
    expect(Date.now() - started).toBeLessThan(500)
  })
  it('handles empty input', () => {
    expect(maskCredentials(null)).toBe('')
    expect(maskCredentials('')).toBe('')
  })
  it('sanitiseBody masks before escaping, so models never see the value', () => {
    expect(sanitiseBody('<b>OTP: 998877</b>')).toBe(`&lt;b&gt;OTP: ${HIDDEN}&lt;/b&gt;`)
  })
})
