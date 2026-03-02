/**
 * Model Test Data Fixtures
 */

export const MODEL_FIXTURES = {
  basic: (vendorId: number) => ({
    name: 'test-model',
    vendor_id: vendorId,
  }),
  gpt35: (vendorId: number) => ({
    name: 'gpt-3.5-turbo',
    vendor_id: vendorId,
  }),
  gpt4: (vendorId: number) => ({
    name: 'gpt-4',
    vendor_id: vendorId,
  }),
  claudeHaiku: (vendorId: number) => ({
    name: 'claude-3-haiku-20240307',
    vendor_id: vendorId,
  }),
  claudeSonnet: (vendorId: number) => ({
    name: 'claude-3-sonnet-20240229',
    vendor_id: vendorId,
  }),
}

export function createRandomModel(vendorId: number, name?: string) {
  return {
    name: name || `test-model-${Date.now()}`,
    vendor_id: vendorId,
  }
}
