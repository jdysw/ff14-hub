// @vitest-environment jsdom
import { cleanup,render,screen,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach,describe,expect,it,vi } from 'vitest';
import type { WorkspaceProfile } from '@ff14-hub/shared';
import { ClientVaultPanel } from '../src/app/fish-sync/ClientVaultPanel';
import type { ApiResult } from '../src/lib/api-client';
import type { ClientVault,DavCredentials,VaultProfile,VaultPurpose } from '@ff14-hub/fish-sync/vault';
import type { Json } from '@ff14-hub/fish-sync';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const workspaceA = '11111111-1111-4111-8111-111111111111';
const workspaceB = '22222222-2222-4222-8222-222222222222';

function profileOf(id: string,region: 'cn'|'global' = 'cn'): WorkspaceProfile {
  return { id,region,timezone: 'Asia/Shanghai',locale: 'zh-CN',createdAt: 1,updatedAt: 1 };
}

function fakeVault() {
  const credentials = new Map<string,DavCredentials>();
  const records = new Map<string,VaultProfile>();
  const vault: ClientVault & { readonly credentials: ReadonlyMap<string,DavCredentials>; readonly saved: VaultProfile[] } = {
    credentials,
    saved: [],
    writeRecord: () => Promise.resolve(),
    readRecord: (_profile: VaultProfile,_purpose: VaultPurpose): Promise<Json|null> => Promise.resolve(null),
    deleteRecord: () => Promise.resolve(),
    saveCredentials: (profile,value) => {
      credentials.set(profile.id,value);
      records.set(profile.id,profile);
      vault.saved.push(profile);
      return Promise.resolve();
    },
    readCredentials: (profile) => Promise.resolve(credentials.get(profile.id) ?? null),
    listProfiles: (scope) =>
      Promise.resolve(
        [...records.values()].filter(
          (item) => item.workspaceId === scope.workspaceId && item.hubOrigin === scope.hubOrigin && (scope.region === undefined || item.region === scope.region),
        ),
      ),
    removeProfile: (profile) => {
      credentials.delete(profile.id);
      records.delete(profile.id);
      return Promise.resolve();
    },
  };
  return vault;
}

const okProfile = (profile: WorkspaceProfile): ApiResult<WorkspaceProfile> => ({ ok: true,status: 200,data: profile });

async function fillForm(): Promise<void> {
  await userEvent.type(screen.getByLabelText(/档案名称/u),'主账号');
  await userEvent.type(screen.getByLabelText(/WebDAV 地址/u),'https://dav.example.com/remote/');
  await userEvent.type(screen.getByLabelText(/WebDAV 用户名/u),'dav-user');
  await userEvent.type(screen.getByLabelText(/WebDAV 口令/u),'secret-password');
}

describe('ClientVaultPanel', () => {
  it('reports profile transport failure without an unhandled rejection', async () => {
    render(<ClientVaultPanel readProfile={()=>Promise.reject(new Error('offline'))} vault={fakeVault()}/>);
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('会话档案读取失败');
    expect(screen.getByRole('button',{name:'加密保存到本机'}).hasAttribute('disabled')).toBe(true);
  });
  it('stores DAV credentials locally under the trusted workspace scope and clears the password input', async () => {
    const vault = fakeVault();
    const readProfile = vi.fn(() => Promise.resolve(okProfile(profileOf(workspaceA))));
    render(<ClientVaultPanel readProfile={readProfile} vault={vault} />);

    await waitFor(() => { expect(readProfile).toHaveBeenCalledTimes(1); });
    expect(screen.getByText(/不会发起任何 WebDAV 网络请求/u)).toBeTruthy();
    expect(screen.getByText('本机没有该区服的档案。')).toBeTruthy();

    await fillForm();
    await userEvent.click(screen.getByRole('button',{ name: '加密保存到本机' }));
    await screen.findByText(/已在本机加密保存该档案/u);

    expect(vault.saved).toHaveLength(1);
    expect(vault.saved[0]?.workspaceId).toBe(workspaceA);
    expect(vault.saved[0]?.hubOrigin).toBe(window.location.origin);
    expect([...vault.credentials.values()]).toEqual([{ username: 'dav-user',password: 'secret-password' }]);
    // 口令输入在保存后立即清空，并且页面上任何地方都不出现口令。
    expect(screen.getByLabelText<HTMLInputElement>(/WebDAV 口令/u).value).toBe('');
    expect(document.body.textContent).not.toContain('secret-password');
    expect(document.body.textContent).toContain('https://dav.example.com/remote/');
  });

  it('verifies that a stored profile can be decrypted without ever revealing the password', async () => {
    const vault = fakeVault();
    render(<ClientVaultPanel readProfile={() => Promise.resolve(okProfile(profileOf(workspaceA)))} vault={vault} />);
    await fillForm();
    await userEvent.click(screen.getByRole('button',{ name: '加密保存到本机' }));
    await screen.findByText(/已在本机加密保存/u);

    await userEvent.click(screen.getByRole('button',{ name: '校验可解密' }));
    await screen.findByText('可解密（仅校验，未显示口令）');
    expect(document.body.textContent).not.toContain('secret-password');
  });

  it('requires an explicit confirmation before deleting a local profile', async () => {
    const vault = fakeVault();
    render(<ClientVaultPanel readProfile={() => Promise.resolve(okProfile(profileOf(workspaceA)))} vault={vault} />);
    await fillForm();
    await userEvent.click(screen.getByRole('button',{ name: '加密保存到本机' }));
    await screen.findByText(/已在本机加密保存/u);

    const remove = screen.getByRole('button',{ name: '删除本机档案' });
    expect(remove).toHaveProperty('disabled',true);
    await userEvent.click(screen.getByLabelText(/我已确认要删除本机档案/u));
    await userEvent.click(remove);
    await screen.findByText(/已删除本机档案/u);
    expect(vault.credentials.size).toBe(0);
    expect(screen.getByText('本机没有该区服的档案。')).toBeTruthy();
  });

  it('keeps drafts while the view is hidden and pauses the trusted profile read', async () => {
    const readProfile = vi.fn(() => Promise.resolve(okProfile(profileOf(workspaceA))));
    const vault = fakeVault();
    const view = render(<ClientVaultPanel readProfile={readProfile} vault={vault} active={false} />);
    expect(readProfile).not.toHaveBeenCalled();
    view.rerender(<ClientVaultPanel readProfile={readProfile} vault={vault} active />);
    await waitFor(() => { expect(readProfile).toHaveBeenCalledTimes(1); });

    await userEvent.type(screen.getByLabelText(/档案名称/u),'草稿中的档案');
    view.rerender(<ClientVaultPanel readProfile={readProfile} vault={vault} active={false} />);
    expect(screen.getByLabelText<HTMLInputElement>(/档案名称/u).value).toBe('草稿中的档案');
    view.rerender(<ClientVaultPanel readProfile={readProfile} vault={vault} active />);
    expect(screen.getByLabelText<HTMLInputElement>(/档案名称/u).value).toBe('草稿中的档案');
    // 重新可见也不会重复读取受信档案。
    expect(readProfile).toHaveBeenCalledTimes(1);
  });

  it('never publishes another session\'s profiles', async () => {
    const vault = fakeVault();
    const first = render(<ClientVaultPanel readProfile={() => Promise.resolve(okProfile(profileOf(workspaceA)))} vault={vault} />);
    await fillForm();
    await userEvent.click(screen.getByRole('button',{ name: '加密保存到本机' }));
    await screen.findByText(/已在本机加密保存/u);
    expect(screen.getByText('主账号')).toBeTruthy();
    first.unmount();

    // 会话切换：AppShell 会以新的 generation 重挂，这里用新工作空间模拟同一效果。
    render(<ClientVaultPanel readProfile={() => Promise.resolve(okProfile(profileOf(workspaceB)))} vault={vault} />);
    await waitFor(() => { expect(screen.getByText('本机没有该区服的档案。')).toBeTruthy(); });
    expect(screen.queryByText('主账号')).toBeNull();
  });

  it('rejects an unsafe DAV address without writing anything to local storage', async () => {
    const vault = fakeVault();
    render(<ClientVaultPanel readProfile={() => Promise.resolve(okProfile(profileOf(workspaceA)))} vault={vault} />);
    await userEvent.type(screen.getByLabelText(/档案名称/u),'不安全');
    await userEvent.type(screen.getByLabelText(/WebDAV 地址/u),'http://dav.example.com/remote/');
    await userEvent.click(screen.getByRole('button',{ name: '加密保存到本机' }));
    await screen.findByRole('alert');
    expect(vault.credentials.size).toBe(0);
  });
});
