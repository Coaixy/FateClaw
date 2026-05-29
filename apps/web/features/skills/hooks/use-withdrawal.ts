'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  type CreatorWithdrawal,
  type WithdrawalBalance,
  withdrawalApi,
} from '@/features/skills/api';
import type { WithdrawalFormState } from '@/components/withdrawal/withdrawal-form';

export const INITIAL_WITHDRAWAL_FORM: WithdrawalFormState = {
  amountCents: '',
  bankName: '',
  bankAccount: '',
  accountName: '',
  idNumber: '',
  taxType: 'personal',
  companyName: '',
  taxId: '',
};

export function useWithdrawal() {
  const [balance, setBalance] = useState<WithdrawalBalance | null>(null);
  const [records, setRecords] = useState<CreatorWithdrawal[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState<WithdrawalFormState>(INITIAL_WITHDRAWAL_FORM);

  const refresh = useCallback(async () => {
    try {
      const [nextBalance, nextRecords] = await Promise.all([
        withdrawalApi.balance(),
        withdrawalApi.list(),
      ]);
      setBalance(nextBalance);
      setRecords(nextRecords);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateField = useCallback(
    <K extends keyof WithdrawalFormState>(
      key: K,
      value: WithdrawalFormState[K],
    ) => {
      setForm((previous) => ({ ...previous, [key]: value }));
    },
    [],
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);
      setSuccess(null);

      const amountCents = Number(form.amountCents);
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        setError('请输入合法的提现金额');
        return;
      }
      if (!balance || amountCents > balance.withdrawable_cents) {
        setError('可提现余额不足');
        return;
      }
      if (!form.bankName || !form.bankAccount || !form.accountName) {
        setError('请填写完整的银行收款信息');
        return;
      }
      if (form.taxType === 'personal' && !form.idNumber) {
        setError('个人提现需提供身份证号');
        return;
      }
      if (form.taxType === 'company' && (!form.companyName || !form.taxId)) {
        setError('对公提现需提供公司名称和税号');
        return;
      }

      setSubmitting(true);
      try {
        await withdrawalApi.create({
          amount_cents: amountCents,
          bank_name: form.bankName,
          bank_account: form.bankAccount,
          account_name: form.accountName,
          id_number: form.idNumber || undefined,
          tax_type: form.taxType,
          company_name: form.companyName || undefined,
          tax_id: form.taxId || undefined,
        });
        setSuccess('申请已提交，平台会在 3-5 个工作日内完成审核');
        setForm((previous) => ({
          ...INITIAL_WITHDRAWAL_FORM,
          bankName: previous.bankName,
          bankAccount: previous.bankAccount,
          accountName: previous.accountName,
          taxType: previous.taxType,
          companyName:
            previous.taxType === 'company' ? previous.companyName : '',
          taxId: previous.taxType === 'company' ? previous.taxId : '',
        }));
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : '提交失败');
      } finally {
        setSubmitting(false);
      }
    },
    [balance, form, refresh],
  );

  return {
    balance,
    records,
    loading,
    submitting,
    error,
    success,
    form,
    updateField,
    submit,
  };
}
