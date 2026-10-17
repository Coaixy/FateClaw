import { describe, expect, test } from 'vitest';
import {
  canAdminSessionAccessPath,
  hasAdminScope,
} from '@/lib/admin-navigation';
import type { AdminSession } from '@/lib/admin-api';

describe('hasAdminScope', () => {
  test('admin:* 可以通过任何 scope 检查', () => {
    expect(hasAdminScope(['admin:*'], 'users:read')).toBe(true);
    expect(hasAdminScope(['admin:*'], 'users:create')).toBe(true);
    expect(hasAdminScope(['admin:*'], 'messages:read')).toBe(true);
  });

  test('具体 scope 只能通过对应检查', () => {
    expect(hasAdminScope(['users:read'], 'users:read')).toBe(true);
    expect(hasAdminScope(['users:read'], 'users:create')).toBe(false);
    expect(hasAdminScope(['users:read'], 'admin:*')).toBe(false);
  });

  test('多个 scope 的任意匹配', () => {
    expect(
      hasAdminScope(['users:read', 'messages:read'], 'messages:read'),
    ).toBe(true);
    expect(hasAdminScope(['users:read', 'messages:read'], 'admin:*')).toBe(
      false,
    );
  });
});

describe('canAdminSessionAccessPath', () => {
  const ownerSession: AdminSession = {
    success: true,
    role: 'owner',
    scopes: ['admin:*'],
    home_path: '/overview',
  };
  const userManagerSession: AdminSession = {
    success: true,
    role: 'user_manager',
    scopes: ['users:read', 'users:create', 'messages:read'],
    home_path: '/users',
  };

  test('owner 可以访问所有管理路径', () => {
    expect(canAdminSessionAccessPath(ownerSession, '/users')).toBe(true);
    expect(canAdminSessionAccessPath(ownerSession, '/billing')).toBe(true);
    expect(canAdminSessionAccessPath(ownerSession, '/system/models')).toBe(
      true,
    );
    expect(
      canAdminSessionAccessPath(ownerSession, '/system/registration-invites'),
    ).toBe(true);
  });

  test('user_manager 只能访问用户和消息路径', () => {
    expect(canAdminSessionAccessPath(userManagerSession, '/users')).toBe(true);
    expect(canAdminSessionAccessPath(userManagerSession, '/messages')).toBe(
      true,
    );
    expect(canAdminSessionAccessPath(userManagerSession, '/billing')).toBe(
      false,
    );
    expect(
      canAdminSessionAccessPath(userManagerSession, '/system/models'),
    ).toBe(false);
    expect(
      canAdminSessionAccessPath(
        userManagerSession,
        '/system/registration-invites',
      ),
    ).toBe(false);
  });
});
