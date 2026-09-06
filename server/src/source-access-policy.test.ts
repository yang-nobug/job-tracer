import assert from 'node:assert/strict'
import test from 'node:test'
import { hasLikelySecretContent, isProtectedSourceName, pathIsWithinScopes } from './source-access-policy.js'

test('源代码访问策略限制配置和凭据文件', () => {
  assert.equal(isProtectedSourceName('.env.production'), true)
  assert.equal(isProtectedSourceName('settings.yaml'), true)
  assert.equal(isProtectedSourceName('service-account.json'), true)
  assert.equal(isProtectedSourceName('src/app.ts'), false)
})

test('源代码访问策略只允许已配置的扫描范围', () => {
  assert.equal(pathIsWithinScopes('server/src/index.ts', ['server/src', 'web/src']), true)
  assert.equal(pathIsWithinScopes('server/private/key.ts', ['server/src', 'web/src']), false)
  assert.equal(pathIsWithinScopes('.', ['server/src']), false)
  assert.equal(pathIsWithinScopes('README.md', ['.']), true)
})

test('源代码访问策略阻止疑似明文密钥但允许环境变量引用', () => {
  assert.equal(hasLikelySecretContent('apiKey: "sk-super-secret-value-123456"'), true)
  assert.equal(hasLikelySecretContent('DATABASE_URL=postgres://app:plain-password@db.example/app'), true)
  assert.equal(hasLikelySecretContent('const apiKey = process.env.ARK_API_KEY'), false)
})
