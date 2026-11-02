import { describe, expect, it } from 'vitest';
import {
  deriveMemorySearchTerms,
  expandMemoryQueryTerms,
  inferMemoryFactKey,
  MEMORY_MAX_SEARCH_TERMS,
  normalizeMemorySearchTerms,
} from '#modules/memory/search-terms';

describe('memory search metadata', () => {
  it('normalizes recoverable labels and bounds malformed or oversized metadata', () => {
    expect(
      normalizeMemorySearchTerms([
        ' 职业 ',
        'ＷＯＲＫ',
        'work',
        '  后端   开发  ',
        '',
        '  ',
        '超'.repeat(33),
        '\u0000职业',
        12,
        { label: '工作' },
      ]),
    ).toEqual(['职业', 'WORK', '后端 开发']);
    const terms = normalizeMemorySearchTerms(
      Array.from({ length: 30 }, (_, index) => `主题${index}`),
    );
    expect(terms).toHaveLength(MEMORY_MAX_SEARCH_TERMS);
    expect(new Set(terms).size).toBe(terms.length);
    expect(normalizeMemorySearchTerms('职业')).toEqual([]);
  });

  it.each([
    '我是一名外科医生。',
    '我的岗位是后端工程师。',
    '我在物流公司上班。',
    '我从事教育行业十年了。',
    '我主要做产品设计。',
    'I work as a cabinet maker.',
    'I am a pediatric surgeon.',
  ])(
    'connects employment statements to occupation questions: %s',
    (content) => {
      const indexed = deriveMemorySearchTerms(content);
      for (const query of ['我从事什么职业？', '我做什么工作？']) {
        expect(
          expandMemoryQueryTerms(query).some((term) => indexed.includes(term)),
        ).toBe(true);
      }
    },
  );

  it.each([
    ['1990年', 'birth_date', '我的生日是哪天？'],
    ['上午九点', 'birth_time', '我几点出生？'],
    ['男', 'gender', '我的性别是什么？'],
    ['南京', 'birthplace', '我在哪里出生？'],
    ['我住在杭州。', undefined, '我现在住哪里？'],
    ['我希望回答简洁。', undefined, '我喜欢你怎么回答？'],
    ['我喜欢用中文交流。', undefined, '我的沟通偏好是什么？'],
  ] as const)(
    'connects a personal-information topic without rewriting its value',
    (content, factKey, query) => {
      const indexed = deriveMemorySearchTerms(content, factKey);
      expect(
        expandMemoryQueryTerms(query).some((term) => indexed.includes(term)),
      ).toBe(true);
      expect(indexed).not.toContain(content);
    },
  );

  it('retains bounded model topics outside the fixed personal-information categories', () => {
    const content = '我每周都会练习大提琴。';
    const terms = deriveMemorySearchTerms(content, undefined, [
      ' 音乐爱好 ',
      '乐器练习',
      '音乐爱好',
    ]);
    expect(terms).toEqual(['音乐爱好', '乐器练习']);
    expect(terms).not.toContain(content);
  });

  it.each([
    '我给医生送了一杯咖啡。',
    '我喜欢看关于外科医生的电影。',
    '工作日上午我喜欢散步。',
    '我从事物变化里找到灵感。',
    '我喜欢喝咖啡。',
    '我住院三天。',
    '我希望学习中文。',
  ])('leaves unrelated statements unclassified: %s', (content) => {
    expect(deriveMemorySearchTerms(content)).toEqual([]);
  });

  it.each(['这部外科医生电影怎么样？', '这是什么原理？', '明天工作前喝什么？'])(
    'does not expand an unrelated query: %s',
    (query) => {
      expect(expandMemoryQueryTerms(query)).toEqual([]);
    },
  );

  it('does not turn an attributed occupational topic into a self fact key', () => {
    const statement = '客户不是一名外科医生。';
    expect(deriveMemorySearchTerms(statement)).toContain('职业');
    expect(inferMemoryFactKey(statement)).toBeUndefined();
  });
});

describe('conservative single-valued memory field inference', () => {
  it.each([
    ['我的生日是农历六月初三。', 'birth_date'],
    ['我1990年2月3日出生。', 'birth_date'],
    ['我出生在1990年。', 'birth_date'],
    ['出生时间：09:30', 'birth_time'],
    ['我上午九点半出生。', 'birth_time'],
    ['我出生在09:30。', 'birth_time'],
    ['我的性别是男。', 'gender'],
    ['我是男的。', 'gender'],
    ['我是女生。', 'gender'],
    ['我出生在南京。', 'birthplace'],
    ['我在北京出生。', 'birthplace'],
    ['我的出生地是杭州。', 'birthplace'],
    ['我现在住在成都。', 'residence'],
    ['住址：合成路十二号', 'residence'],
    ['我是一名外科医生。', 'occupation'],
    ['我的职业是程序员。', 'occupation'],
    ['我从事教师这一职业。', 'occupation'],
  ])(
    'classifies only the field in an explicit self statement: %s',
    (content, key) => {
      expect(inferMemoryFactKey(content)).toBe(key);
    },
  );

  it.each([
    '我在医院工作。',
    '我就职于合成医院。',
    '我的工作单位是合成医院。',
    '我的岗位是后端工程师。',
    '我主要做产品设计。',
  ])(
    'indexes compatible employment context without replacing an occupation: %s',
    (content) => {
      expect(deriveMemorySearchTerms(content)).toContain('职业');
      expect(inferMemoryFactKey(content)).toBeUndefined();
    },
  );

  it.each([
    '1990年',
    '外科医生',
    '对。',
    '我是医生吗？',
    '我父亲是一名外科医生。',
    '客户是一名外科医生。',
    '我打算当外科医生。',
    '我想成为医生。',
    '我是想找外科医生。',
    '我是喜欢看外科医生。',
    '我的职业可能是医生。',
    '如果我是一名医生。',
    '朋友说：“我是一名医生。”',
    '我住在北京，职业是教师。',
    '我住在北京。我是一名教师。',
    '我住在北京同时从事教师职业。',
    '我1990年2月3日早上九点出生。',
    '我出生在北京并且现在住在上海。',
    '我希望回答简洁。',
  ])(
    'keeps ambiguous, attributed, prospective or compound facts unkeyed: %s',
    (content) => {
      expect(inferMemoryFactKey(content)).toBeUndefined();
    },
  );
});
