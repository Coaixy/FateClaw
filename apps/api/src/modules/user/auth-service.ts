import crypto from 'crypto';

import bcrypt from 'bcryptjs';
import type { UserDto } from '@fateclaw/contracts/auth';

import {
  createUserUsing,
  getDbPool,
  getUserByPhone,
  getUserById,
  updateUserPasswordHash,
} from '../../infrastructure/db.js';
import { redeemReferralInviteCodeUsing } from '../../infrastructure/db.js';
import { User } from '../../shared/types.js';
import { toUserDto } from '../../contracts-adapter/auth-contract.js';
import { isValidMainlandChinaPhone, normalizePhoneNumber } from './phone.js';
import { verifySMSCaptcha } from './sms-captcha-service.js';

const SALT_ROUNDS = 10;
const PASSWORD_MIN_LENGTH = 8;

export async function registerUser(
  phone: string,
  password: string,
  smsCaptchaCode: string,
  clientIp: string,
  inviteCode?: string | null,
): Promise<User> {
  const normalizedPhone = normalizePhoneNumber(phone);
  if (!isValidMainlandChinaPhone(normalizedPhone)) {
    throw new Error('手机号格式不正确');
  }

  const existing = await getUserByPhone(normalizedPhone);
  if (existing) {
    throw new Error('该手机号已被注册');
  }

  await verifySMSCaptcha(normalizedPhone, smsCaptchaCode, clientIp);

  const id = crypto.randomUUID();
  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  const now = new Date().toISOString();

  const user: User = {
    id,
    phone: normalizedPhone,
    phone_verified: true,
    password_hash,
    role: 'consumer',
    purchased_coins: 0,
    bonus_coins: 0,
    reserved_coins: 0,
    created_at: now,
  };

  const normalizedInviteCode = inviteCode?.trim() || '';
  if (!normalizedInviteCode) {
    await createUserUsing(getDbPool(), user);
    return user;
  }

  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    await createUserUsing(client, user);
    await redeemReferralInviteCodeUsing(client, {
      inviteeId: user.id,
      code: normalizedInviteCode,
      source: 'register',
    });
    await client.query('COMMIT');
    return user;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function loginUser(
  phone: string,
  password: string,
): Promise<User> {
  const normalizedPhone = normalizePhoneNumber(phone);
  if (!isValidMainlandChinaPhone(normalizedPhone)) {
    throw new Error('手机号或密码错误');
  }

  const user = await getUserByPhone(normalizedPhone);
  if (!user) {
    throw new Error('手机号或密码错误');
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new Error('手机号或密码错误');
  }

  return user;
}

function assertStrongEnoughPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`密码至少 ${PASSWORD_MIN_LENGTH} 位`);
  }
}

export async function changePassword(params: {
  userId: string;
  currentPassword: string;
  nextPassword: string;
}): Promise<void> {
  assertStrongEnoughPassword(params.nextPassword);

  const user = await getUserById(params.userId);
  if (!user) {
    throw new Error('用户不存在');
  }

  const valid = await bcrypt.compare(
    params.currentPassword,
    user.password_hash,
  );
  if (!valid) {
    throw new Error('当前密码不正确');
  }

  if (await bcrypt.compare(params.nextPassword, user.password_hash)) {
    throw new Error('新密码不能与当前密码相同');
  }

  const nextPasswordHash = await bcrypt.hash(params.nextPassword, SALT_ROUNDS);
  await updateUserPasswordHash(user.id, nextPasswordHash);
}

export async function resetPasswordBySMS(params: {
  phone: string;
  nextPassword: string;
  smsCaptchaCode: string;
  clientIp: string;
}): Promise<User> {
  assertStrongEnoughPassword(params.nextPassword);

  const normalizedPhone = normalizePhoneNumber(params.phone);
  if (!isValidMainlandChinaPhone(normalizedPhone)) {
    throw new Error('手机号格式不正确');
  }

  const user = await getUserByPhone(normalizedPhone);
  if (!user) {
    throw new Error('手机号未注册');
  }

  await verifySMSCaptcha(
    normalizedPhone,
    params.smsCaptchaCode,
    params.clientIp,
  );

  const nextPasswordHash = await bcrypt.hash(params.nextPassword, SALT_ROUNDS);
  return updateUserPasswordHash(user.id, nextPasswordHash);
}

/**
 * 读取当前登录用户的完整已验证手机号。
 *
 * 仅供后端认证流程内部使用，普通用户态 DTO 不应把该值返回给前端。
 */
export async function getCurrentUserVerifiedPhone(
  userId: string,
): Promise<string> {
  const user = await getUserById(userId);
  if (!user) {
    throw new Error('用户不存在');
  }
  if (!user.phone_verified) {
    throw new Error('当前账号手机号尚未完成验证');
  }
  return user.phone;
}

/**
 * 使用当前登录用户的后端手机号完成短信验证码重置密码。
 *
 * 前端只提交验证码和新密码，避免把完整手机号往返传输到浏览器。
 */
export async function resetCurrentUserPasswordBySMS(params: {
  userId: string;
  nextPassword: string;
  smsCaptchaCode: string;
  clientIp: string;
}): Promise<User> {
  const phone = await getCurrentUserVerifiedPhone(params.userId);
  return resetPasswordBySMS({
    phone,
    nextPassword: params.nextPassword,
    smsCaptchaCode: params.smsCaptchaCode,
    clientIp: params.clientIp,
  });
}

export async function getUserSafe(userId: string): Promise<UserDto | null> {
  const user = await getUserById(userId);
  if (!user) return null;
  return toUserDto(user);
}
