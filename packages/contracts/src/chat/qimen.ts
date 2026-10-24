const GOD_NAMES: Readonly<Record<string, string>> = {
  符: '值符',
  蛇: '腾蛇',
  螣蛇: '腾蛇',
  阴: '太阴',
  合: '六合',
  勾: '勾陈',
  雀: '朱雀',
  常: '太常',
  虎: '白虎',
  地: '九地',
  天: '九天',
  玄: '玄武',
};

/** Resolve upstream and stored abbreviations to the public Qimen god names. */
export function fullQimenGodName(name: string): string {
  return Object.hasOwn(GOD_NAMES, name) ? GOD_NAMES[name]! : name;
}
