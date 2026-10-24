import { expect, it } from 'vitest';
import { safeReturnPath } from '../src/lib/navigation';
it('resumes shared evidence URLs without allowing external redirects', () => {
  const origin = 'https://dashboard.example.com';
  expect(safeReturnPath('/runs/test?tab=cases&case=TC002', origin)).toBe('/runs/test?tab=cases&case=TC002');
  for (const value of ['//evil.example', '/\\evil.example', '/\n/evil.example', 'https://evil.example', null]) expect(safeReturnPath(value, origin)).toBe('/');
});
