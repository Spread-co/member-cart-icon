export default {
  editor: {
    label: { en: 'Member Cart Icon' },
    icon: 'shopping-bag',
    categories: ['ecommerce', 'navigation'],
  },
  properties: {
    supabaseUrl: {
      label: { en: 'Supabase URL' },
      type: 'Text',
      bindable: true,
      hidden: true,
      defaultValue: '',
    },
    supabaseAnonKey: {
      label: { en: 'Supabase Anon Key' },
      type: 'Text',
      bindable: true,
      hidden: true,
      defaultValue: '',
    },
    accessToken: {
      label: { en: 'Auth Access Token' },
      type: 'Text',
      bindable: true,
      hidden: true,
      defaultValue: '',
    },
    isMember: {
      label: { en: 'Is Member' },
      type: 'OnOff',
      bindable: true,
      defaultValue: false,
    },
    householdId: {
      label: { en: 'Household ID' },
      type: 'Text',
      bindable: true,
      hidden: true,
      defaultValue: '',
    },
    portalTarget: {
      label: { en: 'Portal Target' },
      type: 'Text',
      bindable: true,
      hidden: true,
      defaultValue: '',
    },
  },
  triggerEvents: [
    {
      name: 'cart:open',
      label: { en: 'On Cart Open' },
      event: { cartId: '', itemCount: 0 },
    },
    {
      name: 'cart:locked',
      label: { en: 'On Cart Locked (Non-Member)' },
      event: {},
    },
  ],
};
