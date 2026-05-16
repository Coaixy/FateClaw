import { describe, expect, it } from 'vitest';

import {
  executeKnowledgeTool,
  formatSectionIndex,
  splitUserSkillIntoSections,
  type KnowledgeSkillBundle,
} from './xuanxue-knowledge.js';

describe('xuanxue knowledge sections', () => {
  it('indexes level-three headings as readable sections', () => {
    const content = [
      '# 六爻财运经营类象',
      '',
      '知识库说明。',
      '',
      '## 分章节知识',
      '### 主题总论',
      '经营财运先看财源结构。',
      '',
      '### 关键判断',
      '再看动爻与世应关系。',
    ].join('\n');

    const sections = splitUserSkillIntoSections(content);

    expect(sections.map((section) => section.title)).toEqual([
      '(前言)',
      '分章节知识',
      '主题总论',
      '关键判断',
    ]);
    expect(sections.find((section) => section.title === '主题总论')).toEqual(
      expect.objectContaining({
        body: '经营财运先看财源结构。',
        level: 3,
      }),
    );
  });

  it('can read a level-three section by its exact title', () => {
    const bundle: KnowledgeSkillBundle = {
      skill_dir: 'user-六爻财运经营类象',
      skill_name: '六爻财运经营类象',
      usage_mode: 'reference_only',
      category: '六爻',
      category_normalized: '六爻',
      sections: splitUserSkillIntoSections(
        [
          '## 分章节知识',
          '### 主题总论',
          '经营财运先看财源结构。',
        ].join('\n'),
      ),
    };

    const result = executeKnowledgeTool(
      'read_knowledge_section',
      {
        skill_dir: 'user-六爻财运经营类象',
        section_title: '主题总论',
      },
      [bundle],
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.output)).toEqual(
      expect.objectContaining({
        skill_dir: 'user-六爻财运经营类象',
        section_title: '主题总论',
        body: '经营财运先看财源结构。',
      }),
    );
  });

  it('includes knowledge metadata in the section index', () => {
    const index = formatSectionIndex([
      {
        skill_dir: 'user-六爻财运经营类象',
        skill_name: '六爻财运经营类象',
        usage_mode: 'reference_only',
        category: '六爻',
        category_normalized: '六爻',
        description: '六爻财运经营判断',
        trigger_hint: '遇到财运、经营、生意问题时参考',
        match_keywords: ['财运', '经营'],
        example_queries: ['解读财运'],
        sections: splitUserSkillIntoSections('## 主题总论\n经营财运先看财源结构。'),
      },
    ]);

    expect(index).toContain('【六爻财运经营类象】');
    expect(index).toContain('description="六爻财运经营判断"');
    expect(index).toContain('keywords="财运、经营"');
    expect(index).toContain('examples="解读财运"');
  });

  it('accepts final_answer as a terminating knowledge tool', () => {
    const result = executeKnowledgeTool(
      'final_answer',
      { text: '这是最终解读' },
      [],
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('这是最终解读');
  });

  it('rejects final_answer without text', () => {
    const result = executeKnowledgeTool('final_answer', {}, []);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('final_answer.text');
  });
});
