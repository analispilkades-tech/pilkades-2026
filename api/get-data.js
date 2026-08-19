const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const { data, error } = await supabase
    .from('hasil_suara')
    .select('*')
    .order('timestamp', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
};