// The signed-in account as the whole site needs it: the summary from
// GET /api/account (profile, providers, security state), the profile
// picture, and two preference documents read everywhere - display (privacy
// mode) and investments (main currency, default fees).
//
// The privacy flag is applied to the money formatter the moment it is
// known or changed (utils/formatters.js), and saved to the account, so it
// is the same on every device.
import { useCallback, useEffect, useState } from 'react';
import { getAccount, putAccount } from '../accountApi';
import { setAmountsHidden } from '../utils/formatters';
import { displayNameOf } from '../components/ui/Avatar';

export function useAccount(user) {
  const [account, setAccount] = useState(null);
  const [avatar, setAvatar] = useState(null);
  const [display, setDisplay] = useState({ hideAmounts: false });
  const [investments, setInvestments] = useState({});

  const refresh = useCallback(async () => {
    if (!user) return;
    const [summary, pic, disp, inv] = await Promise.all([
      getAccount('/api/account'),
      getAccount('/api/account/avatar'),
      getAccount('/api/preferences/display'),
      getAccount('/api/preferences/investments')
    ]);
    if (summary.ok) setAccount(summary.data);
    if (pic.ok) setAvatar(pic.data.dataUrl || null);
    if (disp.ok) {
      const value = { hideAmounts: false, ...(disp.data.value || {}) };
      setAmountsHidden(value.hideAmounts);
      setDisplay(value);
    }
    if (inv.ok) setInvestments(inv.data.value || {});
  }, [user]);

  useEffect(() => {
    if (!user) {
      setAccount(null);
      setAvatar(null);
      setAmountsHidden(false);
      setDisplay({ hideAmounts: false });
      setInvestments({});
      return;
    }
    refresh();
  }, [user, refresh]);

  // Optimistic: the masks change at once; the saved value follows.
  const setHideAmounts = useCallback(async (hide) => {
    setAmountsHidden(hide);
    setDisplay((d) => ({ ...d, hideAmounts: hide }));
    const r = await putAccount('/api/preferences/display', { hideAmounts: hide });
    return r.ok;
  }, []);

  const saveInvestments = useCallback(async (value) => {
    const r = await putAccount('/api/preferences/investments', value);
    if (r.ok) setInvestments(r.data.value || {});
    return r;
  }, []);

  const profile = account ? account.profile : null;
  return {
    account,
    profile,
    avatar,
    setAvatar,
    displayName: displayNameOf(profile, user && user.email),
    hideAmounts: Boolean(display.hideAmounts),
    setHideAmounts,
    investments,
    saveInvestments,
    refresh
  };
}
