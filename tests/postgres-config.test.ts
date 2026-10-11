import { expect, it } from 'vitest';
import { postgresConnectionString } from '../lib/server/db';

it('retains full TLS verification when normalizing deprecated PostgreSQL sslmode aliases', () => {
  for (const mode of ['prefer', 'require', 'verify-ca']) {
    const result = new URL(postgresConnectionString(`postgresql://test-user:test-password@database.example.test/lume?sslmode=${mode}&channel_binding=require`));
    expect(result.searchParams.get('sslmode')).toBe('verify-full');
    expect(result.searchParams.get('channel_binding')).toBe('require');
    expect(result.username).toBe('test-user');
    expect(result.password).toBe('test-password');
  }
});

it('preserves explicit libpq compatibility and other TLS settings', () => {
  for (const query of ['sslmode=require&uselibpqcompat=true', 'sslmode=verify-full', 'sslmode=disable', '']) {
    const value = `postgresql://database.example.test/lume${query ? '?' + query : ''}`;
    expect(postgresConnectionString(value)).toBe(value);
  }
});
